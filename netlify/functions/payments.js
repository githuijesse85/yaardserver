import { query } from "../../shared/db";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware";
import { verifyTransaction, validateWebhook, refundTransaction } from "../../shared/paystack";

export async function handler(event, context) {
  // CRITICAL FIX: Signals Netlify workers to immediately pause processing,
  // preventing hanging or idling DB connection pools from generating 504 timeouts.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/payments", "").replace("/api/payments", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // GET / — List User Payment Ledgers
    // ─────────────────────────────────────────────────────────────────────────
    if ((path === "" || path === "/") && method === "GET") {
      const { userId } = requireAuth(event);
      
      const res = await query(
        `SELECT p.*, a.title AS ad_title
         FROM payments p
         LEFT JOIN ads a ON a.id = p.ad_id
         WHERE p.user_id = $1
         ORDER BY p.created_at DESC
         LIMIT 50`,
        [userId]
      );
      
      return success(res.rows, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /verify/:reference — Operational Transaction Verification
    // ─────────────────────────────────────────────────────────────────────────
    if (path.startsWith("/verify/") && method === "GET") {
      const reference = path.replace("/verify/", "");
      const { userId } = requireAuth(event);

      if (!reference) {
        return error("Transaction lookup reference parameters cannot be empty.", event, 400);
      }

      const paystackData = await verifyTransaction(reference);

      if (paystackData?.data?.status === "success") {
        // Idempotent state updates: Sync payment and live ad status maps concurrently
        await Promise.all([
          query(
            `UPDATE payments 
             SET status = 'success', paid_at = NOW(), metadata = $1
             WHERE paystack_reference = $2 AND user_id = $3`,
            [JSON.stringify(paystackData.data), reference, userId]
          ),
          query(
            `UPDATE ads 
             SET status = 'active', payment_status = 'paid', starts_at = COALESCE(starts_at, NOW())
             WHERE paystack_reference = $1`,
            [reference]
          )
        ]);

        const adRes = await query(
          "SELECT * FROM ads WHERE paystack_reference = $1",
          [reference]
        );

        return success({
          verified: true,
          status: "success",
          amount: paystackData.data.amount / 100,
          currency: paystackData.data.currency,
          ad: adRes.rows[0] || null,
          transaction: paystackData.data,
        }, event);
      } else {
        await query(
          "UPDATE payments SET status = 'failed' WHERE paystack_reference = $1 AND status = 'pending'",
          [reference]
        );
        
        return success({
          verified: true,
          status: paystackData?.data?.status || "failed",
          transaction: paystackData?.data || null,
        }, event);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /webhook — Secure Inbound Event Handlers
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/webhook" && method === "POST") {
      // Netlify normalizes incoming keys; check both case types for security validation
      const signature = event.headers["x-paystack-signature"] || event.headers["X-Paystack-Signature"];
      
      // FIX: validateWebhook expects (rawBody, signature) — previously reversed
      const isValid = validateWebhook(event.body, signature);
      if (!isValid) {
        return error("Cryptographic webhook validation signature mismatch.", event, 401);
      }

      const { event: eventType, data } = parseBody(event);
      const reference = data?.reference || data?.transaction_reference;

      if (!reference) {
        return { statusCode: 200, body: JSON.stringify({ received: true, note: "Skipped due to empty reference payload context" }) };
      }

      if (eventType === "charge.success") {
        await Promise.all([
          query(
            "UPDATE payments SET status = 'success', paid_at = NOW(), metadata = $1 WHERE paystack_reference = $2 AND status != 'success'",
            [JSON.stringify(data), reference]
          ),
          query(
            "UPDATE ads SET status = 'active', payment_status = 'paid', starts_at = COALESCE(starts_at, NOW()) WHERE paystack_reference = $1",
            [reference]
          )
        ]);
      } else if (eventType === "charge.failed") {
        await query(
          "UPDATE payments SET status = 'failed' WHERE paystack_reference = $1 AND status = 'pending'",
          [reference]
        );
      } else if (eventType === "refund.processed") {
        await Promise.all([
          query("UPDATE payments SET status = 'refunded' WHERE paystack_reference = $1", [reference]),
          query("UPDATE ads SET status = 'paused' WHERE paystack_reference = $1", [reference])
        ]);
      }

      return { 
        statusCode: 200, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ received: true }) 
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /stats — Normalized Analytics Instrumentation Nodes
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/stats" && method === "GET") {
      const { userId } = requireAuth(event);

      // PERFORMANCE OPTIMIZATION: Combine analytical computations into clean numeric arrays
      const [paymentStats, adStats] = await Promise.all([
        query(
          `SELECT
             COUNT(*)::int AS total_payments,
             COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0)::numeric AS total_spent,
             COUNT(CASE WHEN status = 'success' THEN 1 END)::int AS successful_payments
           FROM payments WHERE user_id = $1`,
          [userId]
        ),
        query(
          `SELECT
             COUNT(*)::int AS total_ads,
             COUNT(CASE WHEN status = 'active' THEN 1 END)::int AS active_ads,
             COALESCE(SUM(impressions), 0)::bigint AS total_impressions,
             COALESCE(SUM(clicks), 0)::bigint AS total_clicks,
             COALESCE(SUM(spent), 0)::numeric AS total_ad_spend
           FROM ads WHERE user_id = $1`,
          [userId]
        ),
      ]);

      return success({
        payments: paymentStats.rows[0],
        ads: adStats.rows[0],
      }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /refund/:reference — Secure Financial Refund Matrix Node
    // ─────────────────────────────────────────────────────────────────────────
    if (path.startsWith("/refund/") && method === "POST") {
      const { userId } = requireAuth(event);
      const reference = path.replace("/refund/", "");
      const { amount } = parseBody(event);

      if (!reference) {
        return error("Target refund identifier context strings are missing.", event, 400);
      }

      // Verify asset profile ownership records first
      const paymentRes = await query(
        "SELECT * FROM payments WHERE paystack_reference = $1 AND user_id = $2",
        [reference, userId]
      );
      
      if (paymentRes.rows.length === 0) {
        return error("Specified payment transaction node records not found.", event, 404);
      }

      const payment = paymentRes.rows[0];
      if (payment.status !== "success") {
        return error("Refund transactions can only process against completed success metrics.", event, 400);
      }

      const refundData = await refundTransaction(reference, amount);

      if (refundData?.status) {
        // Atomically lock down transactional scopes on vendor profiles
        await Promise.all([
          query("UPDATE payments SET status = 'refunded' WHERE paystack_reference = $1", [reference]),
          query("UPDATE ads SET status = 'paused' WHERE paystack_reference = $1", [reference])
        ]);
      }

      return success({ refund: refundData?.data || null }, event);
    }

    return error("Requested resource payments context route mapping tree mismatch.", event, 404);
  } catch (err) {
    console.error("Centralized Payments Pipeline Matrix Exception:", err);
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal core payment processing ecosystem exception", event, statusCode);
  }
}