/**
 * @fileoverview Shared Paystack payment gateway integration for Yaard API.
 *
 * Wraps the Paystack REST API for transaction initialisation, verification,
 * webhook validation, and refunds.
 */

import crypto from "crypto";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_LIVE_SECRET_KEY;
  if (!key) {
    const err = new Error(
      "Paystack is not configured. Set PAYSTACK_SECRET_KEY in your environment variables."
    );
    err.statusCode = 503;
    throw err;
  }
  return key;
}

/**
 * Low-level Paystack API caller.
 *
 * @param {string} method  - HTTP method
 * @param {string} path    - API path (e.g. '/transaction/initialize')
 * @param {object} [body]  - Request body (for POST/PUT)
 * @returns {Promise<object>} Parsed Paystack response
 */
async function paystackRequest(method, path, body) {
  const url = `${PAYSTACK_BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${getSecretKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const options = {
    method: method.toUpperCase(),
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Paystack API returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const err = new Error(
      json?.message || `Paystack API error: HTTP ${res.status}`
    );
    err.statusCode = res.status >= 500 ? 502 : res.status;
    err.paystackStatus = res.status;
    throw err;
  }

  return json;
}

// ── TRANSACTION INITIALISATION ────────────────────────────────────────────────

/**
 * Initialise a Paystack transaction (charge).
 *
 * @param {object} params
 * @param {string} params.email         - Customer email
 * @param {number} params.amount        - Amount in MAJOR currency units (KES, NGN, etc.)
 *                                        Automatically multiplied by 100 to convert to
 *                                        Paystack's smallest unit (kobo/pesewa) before sending.
 *                                        Callers must NOT pre-multiply — pass the raw amount
 *                                        as displayed to the user (e.g. 1000 for KES 1,000).
 * @param {string} params.reference     - Unique transaction reference
 * @param {string} [params.currency]    - Currency code (default: 'KES')
 * @param {string} [params.callbackUrl] - Redirect URL after payment
 * @param {object} [params.metadata]    - Custom metadata attached to the transaction
 * @returns {Promise<object>} Paystack initialise response
 */
export async function initializeTransaction({
  email,
  amount,
  reference,
  currency = "KES",
  callbackUrl,
  metadata,
}) {
  if (!email || !amount || !reference) {
    const err = new Error("email, amount, and reference are required for payment initialization.");
    err.statusCode = 400;
    throw err;
  }

  // Paystack requires amount in the smallest currency unit (kobo for NGN, pesewa for GHS, etc.)
  // Our callers pass major units (e.g. KES 1000), so we multiply by 100 here.
  const amountInSubunits = Math.round(parseFloat(amount) * 100);

  return paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountInSubunits,
    reference,
    currency,
    callback_url: callbackUrl,
    metadata,
  });
}

// ── TRANSACTION VERIFICATION ──────────────────────────────────────────────────

/**
 * Verify the status of a Paystack transaction by reference.
 *
 * @param {string} reference - The transaction reference to verify
 * @returns {Promise<object>} Paystack verify response
 */
export async function verifyTransaction(reference) {
  if (!reference) {
    const err = new Error("Transaction reference is required.");
    err.statusCode = 400;
    throw err;
  }
  return paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}

// ── WEBHOOK VALIDATION ────────────────────────────────────────────────────────

/**
 * Validate a Paystack webhook signature.
 *
 * Paystack signs the raw request body with HMAC-SHA512 using the secret key
 * and sends the hash in the x-paystack-signature header.
 *
 * @param {string} rawBody     - Raw (unparsed) request body string
 * @param {string} signature   - Value of the x-paystack-signature header
 * @returns {boolean} True if the signature is valid
 */
export function validateWebhook(rawBody, signature) {
  if (!rawBody || !signature) return false;

  try {
    const secretKey = getSecretKey();
    const hash = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody, "utf8")
      .digest("hex");

    return hash === signature;
  } catch {
    return false;
  }
}

// ── REFUNDS ───────────────────────────────────────────────────────────────────

/**
 * Initiate a refund for a completed transaction.
 *
 * @param {string} reference         - Transaction reference to refund
 * @param {number} [amountKobo]      - Partial refund amount in kobo; omit for full refund
 * @returns {Promise<object>} Paystack refund response
 */
export async function refundTransaction(reference, amountKobo) {
  if (!reference) {
    const err = new Error("Transaction reference is required for refund.");
    err.statusCode = 400;
    throw err;
  }

  const body = { transaction: reference };
  if (amountKobo !== undefined && amountKobo !== null) {
    body.amount = Math.round(amountKobo);
  }

  return paystackRequest("POST", "/refund", body);
}

// ── CUSTOMER HELPERS ──────────────────────────────────────────────────────────

/**
 * List transactions for a given customer email.
 *
 * @param {string} email - Customer email address
 * @param {number} [perPage=20]
 * @returns {Promise<object>}
 */
export async function listCustomerTransactions(email, perPage = 20) {
  return paystackRequest(
    "GET",
    `/transaction?customer=${encodeURIComponent(email)}&perPage=${perPage}`
  );
}
