import { v4 as uuidv4 } from "uuid";
import { query } from "../../shared/db.js";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware.js";
import { initializeTransaction } from "../../shared/paystack.js";

// The Android client (see MOBILE_API_INTEGRATION.md / videos.js body handling) sends
// ad targeting fields in snake_case (video_id, target_url, target_categories, ...).
// This file previously destructured ONLY camelCase keys, so any snake_case payload
// silently resulted in `undefined` -> null/default values on every targeting column.
// getField() mirrors the same dual-casing fallback already used in videos.js.
function getField(body, snakeKey, camelKey) {
  if (body[snakeKey] !== undefined) return body[snakeKey];
  if (body[camelKey] !== undefined) return body[camelKey];
  return undefined;
}

// Normalizes a targeting value that may arrive as an array, a single string, or
// missing entirely into either a Postgres-friendly array or null.
function toArrayOrNull(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return null;
}

// starts_at/ends_at are now DATE columns (migration 010), fed by a plain date
// picker on the Android client. Accepts a bare "YYYY-MM-DD" string, a full
// ISO timestamp ("2026-07-08T00:00:00.000Z"), or a JS Date, and always
// returns a clean "YYYY-MM-DD" string (or null). Throws on anything
// unparsable so callers can return a 400 instead of a silent bad insert.
function toDateOnly(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error('Invalid date');
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) throw new Error('Invalid date');
    return parsed.toISOString().slice(0, 10);
  }
  throw new Error('Invalid date');
}

export async function handler(event, context) {
  // CRITICAL FIX: Informs Netlify not to wait for open idle PostgreSQL pool connections
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/ads", "").replace("/api/ads", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // GET / — List authenticating vendor's ad campaigns
    if ((path === "" || path === "/") && method === "GET") {
      const { userId } = requireAuth(event);
      const res = await query(
        `SELECT a.*, v.title as video_title, v.price_mode as video_price_mode, v.thumbnail_url
         FROM ads a
         LEFT JOIN videos v ON v.id = a.video_id
         WHERE a.user_id = $1
         ORDER BY a.created_at DESC`,
        [userId]
      );
      return success(res.rows, event);
    }

    // POST / — Create ad listing and initialize Paystack gateway payload
    if ((path === "" || path === "/") && method === "POST") {
      const { userId } = requireAuth(event);
      const body = parseBody(event);
      const { title, description, budget, currency, email } = body;

      // Ad targeting + linkage fields: accept both snake_case (what the Android
      // client actually sends) and camelCase, so record creation never silently
      // drops these columns.
      const videoId = getField(body, 'video_id', 'videoId');
      const targetUrl = getField(body, 'target_url', 'targetUrl');
      const targetCategories = getField(body, 'target_categories', 'targetCategories');
      const targetLocations = getField(body, 'target_locations', 'targetLocations');
      const targetCountries = getField(body, 'target_countries', 'targetCountries');
      const targetPreferences = getField(body, 'target_preferences', 'targetPreferences');
      const targetAgeMin = getField(body, 'target_age_min', 'targetAgeMin');
      const targetAgeMax = getField(body, 'target_age_max', 'targetAgeMax');
      const startsAt = getField(body, 'starts_at', 'startsAt');
      const endsAt = getField(body, 'ends_at', 'endsAt');
      const callbackUrl = getField(body, 'callback_url', 'callbackUrl');

      if (!title || !budget || !email) {
        return error("Title, budget, and email are required parameters.", event, 400);
      }
      
      const parsedBudget = parseFloat(budget);
      if (isNaN(parsedBudget) || parsedBudget < 1000) {
        return error("Minimum ad budget limit configuration is KSh 1,000", event, 400);
      }

      // starts_at/ends_at columns are DATE (migration 010) — normalize whatever
      // the client sent (bare date, full timestamp) into "YYYY-MM-DD".
      let startsAtDate, endsAtDate;
      try {
        startsAtDate = toDateOnly(startsAt);
        endsAtDate = toDateOnly(endsAt);
      } catch (e) {
        return error("starts_at and ends_at must be valid dates (YYYY-MM-DD)", event, 400);
      }
      if (startsAtDate && endsAtDate && endsAtDate < startsAtDate) {
        return error("ends_at cannot be before starts_at", event, 400);
      }

      // Generate a clean, verifiable deterministic accounting invoice reference string
      const reference = `YAARD_AD_${uuidv4().replace(/-/g, "").toUpperCase().slice(0, 16)}`;

      // Reformat standard JS arrays into operational Postgres Text-Array literal syntax ({val1,val2}) safely.
      // Also tolerate a single string value (e.g. one category) instead of requiring an array.
      const formattedCategories = toArrayOrNull(targetCategories);
      const formattedLocations = toArrayOrNull(targetLocations);
      const formattedCountries = toArrayOrNull(targetCountries);
      const formattedPreferences = toArrayOrNull(targetPreferences);

      // 1. Persist Ad Record layout definition details
      const adRes = await query(
        `INSERT INTO ads (
           user_id, video_id, title, description, target_url, budget, currency,
           target_categories, target_locations, target_countries, target_preferences, target_age_min, target_age_max,
           starts_at, ends_at, paystack_reference, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
         RETURNING *`,
        [
          userId, videoId || null, title, description || null, targetUrl || null,
          parsedBudget, currency || "KES",
          formattedCategories, formattedLocations, formattedCountries, formattedPreferences,
          targetAgeMin || 18, targetAgeMax || 65,
          startsAtDate, endsAtDate, reference,
        ]
      );
      const ad = adRes.rows[0];

      // 2. Queue historical verification ledger trace record inside Payments Table
      await query(
        `INSERT INTO payments (user_id, ad_id, amount, currency, paystack_reference, payment_type, status)
         VALUES ($1, $2, $3, $4, $5, 'ad', 'pending')`,
        [userId, ad.id, parsedBudget, currency || "KES", reference]
      );

      // Notify followers of the advertiser that a new ad campaign has been created
      await query(
        `INSERT INTO notifications (user_id, from_user_id, type, title, body, data)
         SELECT follower_id, $1, 'new_ad', $2, $3, $4
         FROM follows
         WHERE following_id = $1`,
        [
          userId,
          `New ad campaign from a creator`,
          `${title} is now pending activation`,
          JSON.stringify({ ad_id: ad.id, video_id: videoId || null, title, user_id: userId })
        ]
      );

      // 3. Initialize explicit remote transaction checkout flow via Paystack API Engine
      // CRITICAL: Amount multiplied by 100 converts raw KES currency directly into structural subunits (cents/kobo)
      const paystackRes = await initializeTransaction({
        email,
        amount: parsedBudget,
        reference,
        callbackUrl: callbackUrl || `${(process.env.APP_URL || 'https://yaard.netlify.app').replace(/\/$/, '')}/ads/payment/callback`,
        metadata: {
          ad_id: ad.id,
          user_id: userId,
          ad_title: title,
          custom_fields: [
            { display_name: "Ad Title", variable_name: "ad_title", value: title },
            { display_name: "Ad ID", variable_name: "ad_id", value: ad.id },
          ],
        },
      });

      return success({
        ad,
        payment: {
          reference,
          authorizationUrl: paystackRes.data?.authorization_url,
          accessCode: paystackRes.data?.access_code,
        },
      }, event, 201);
    }

    // GET /:id — Fetch singular matching targeting performance context
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === "GET") {
      const { userId } = requireAuth(event);
      const adId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];
      
      const res = await query(
        `SELECT a.*, v.title as video_title, v.price_mode as video_price_mode, v.thumbnail_url 
         FROM ads a 
         LEFT JOIN videos v ON v.id = a.video_id 
         WHERE a.id = $1 AND a.user_id = $2`,
        [adId, userId]
      );
      
      if (res.rows.length === 0) return error("Ad campaign profile records not found", event, 404);
      return success(res.rows[0], event);
    }

    // PUT /:id — Update pending or active campaign parameters, including targeting filters
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === "PUT") {
      const { userId } = requireAuth(event);
      const adId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];
      const body = parseBody(event);
      const { status, title, description, budget, currency } = body;
      const targetUrl = getField(body, 'target_url', 'targetUrl');
      const targetCategories = getField(body, 'target_categories', 'targetCategories');
      const targetLocations = getField(body, 'target_locations', 'targetLocations');
      const targetCountries = getField(body, 'target_countries', 'targetCountries');
      const targetPreferences = getField(body, 'target_preferences', 'targetPreferences');
      const targetAgeMin = getField(body, 'target_age_min', 'targetAgeMin');
      const targetAgeMax = getField(body, 'target_age_max', 'targetAgeMax');
      const startsAt = getField(body, 'starts_at', 'startsAt');
      const endsAt = getField(body, 'ends_at', 'endsAt');

      const updates = [];
      const sqlParams = [];
      let paramCounter = 1;

      if (status !== undefined) {
        const allowedStatuses = ["paused", "active"];
        if (!allowedStatuses.includes(status)) {
          return error("Invalid structural status modification state. Use: paused or active", event, 400);
        }
        updates.push(`status = $${paramCounter++}`);
        sqlParams.push(status);
      }
      if (title !== undefined) {
        updates.push(`title = $${paramCounter++}`);
        sqlParams.push(title);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramCounter++}`);
        sqlParams.push(description);
      }
      if (targetUrl !== undefined) {
        updates.push(`target_url = $${paramCounter++}`);
        sqlParams.push(targetUrl);
      }
      if (budget !== undefined) {
        const parsedBudget = parseFloat(budget);
        if (isNaN(parsedBudget) || parsedBudget < 0) {
          return error("budget must be a valid number", event, 400);
        }
        updates.push(`budget = $${paramCounter++}`);
        sqlParams.push(parsedBudget);
      }
      if (currency !== undefined) {
        updates.push(`currency = $${paramCounter++}`);
        sqlParams.push(currency);
      }
      if (targetCategories !== undefined) {
        const normalized = toArrayOrNull(targetCategories);
        if (normalized === null && targetCategories !== null) {
          return error("target_categories must be an array (or a single string)", event, 400);
        }
        updates.push(`target_categories = $${paramCounter++}`);
        sqlParams.push(normalized);
      }
      if (targetLocations !== undefined) {
        const normalized = toArrayOrNull(targetLocations);
        if (normalized === null && targetLocations !== null) {
          return error("target_locations must be an array (or a single string)", event, 400);
        }
        updates.push(`target_locations = $${paramCounter++}`);
        sqlParams.push(normalized);
      }
      if (targetCountries !== undefined) {
        const normalized = toArrayOrNull(targetCountries);
        if (normalized === null && targetCountries !== null) {
          return error("target_countries must be an array (or a single string)", event, 400);
        }
        updates.push(`target_countries = $${paramCounter++}`);
        sqlParams.push(normalized);
      }
      if (targetPreferences !== undefined) {
        const normalized = toArrayOrNull(targetPreferences);
        if (normalized === null && targetPreferences !== null) {
          return error("target_preferences must be an array (or a single string)", event, 400);
        }
        updates.push(`target_preferences = $${paramCounter++}`);
        sqlParams.push(normalized);
      }
      if (targetAgeMin !== undefined) {
        updates.push(`target_age_min = $${paramCounter++}`);
        sqlParams.push(targetAgeMin);
      }
      if (targetAgeMax !== undefined) {
        updates.push(`target_age_max = $${paramCounter++}`);
        sqlParams.push(targetAgeMax);
      }
      if (startsAt !== undefined) {
        let startsAtDate;
        try {
          startsAtDate = toDateOnly(startsAt);
        } catch (e) {
          return error("starts_at must be a valid date (YYYY-MM-DD)", event, 400);
        }
        updates.push(`starts_at = $${paramCounter++}`);
        sqlParams.push(startsAtDate);
      }
      if (endsAt !== undefined) {
        let endsAtDate;
        try {
          endsAtDate = toDateOnly(endsAt);
        } catch (e) {
          return error("ends_at must be a valid date (YYYY-MM-DD)", event, 400);
        }
        updates.push(`ends_at = $${paramCounter++}`);
        sqlParams.push(endsAtDate);
      }

      if (updates.length === 0) {
        return error("No valid ad update fields provided.", event, 400);
      }

      const res = await query(
        `UPDATE ads SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${paramCounter++} AND user_id = $${paramCounter++} RETURNING *`,
        [...sqlParams, adId, userId]
      );
      
      if (res.rows.length === 0) return error("Target campaign profile mismatch or mutation unauthorized", event, 403);
      return success(res.rows[0], event);
    }

    // POST /:id/activate — Re-initialize Paystack payment for a pending/inactive ad
    // Called when the user taps "Activate" on an existing ad that has no live payment URL.
    if (path.match(/^\/([a-zA-Z0-9-]+)\/activate$/) && method === "POST") {
      const { userId } = requireAuth(event);
      const adId = path.match(/^\/([a-zA-Z0-9-]+)\/activate$/)[1];
      const activateBody = parseBody(event);
      const { email } = activateBody;
      const callbackUrl = getField(activateBody, 'callback_url', 'callbackUrl');

      if (!email) {
        return error("email is required to initialize payment", event, 400);
      }

      // Fetch the ad and verify ownership
      const adRes = await query(
        `SELECT * FROM ads WHERE id = $1 AND user_id = $2`,
        [adId, userId]
      );
      if (adRes.rows.length === 0) {
        return error("Ad not found or unauthorized", event, 404);
      }
      const ad = adRes.rows[0];

      // Only pending/inactive ads can be activated via payment
      if (ad.status === "active") {
        return error("Ad is already active", event, 400);
      }

      // Always generate a NEW reference for each payment attempt
      // (Paystack prevents reusing references, even for the same transaction)
      const reference = `YAARD_AD_${uuidv4().replace(/-/g, "").toUpperCase().slice(0, 16)}`;

      // Update the ad with the new reference
      await query("UPDATE ads SET paystack_reference = $1 WHERE id = $2", [reference, adId]);
      
      // Insert new payment record for this activation attempt
      await query(
        `INSERT INTO payments (user_id, ad_id, amount, currency, paystack_reference, payment_type, status)
         VALUES ($1, $2, $3, $4, $5, 'ad', 'pending')
         ON CONFLICT (paystack_reference) DO NOTHING`,
        [userId, adId, ad.budget, ad.currency || "KES", reference]
      );

      // Re-initialize Paystack transaction
      const paystackRes = await initializeTransaction({
        email,
        amount: parseFloat(ad.budget),
        reference,
        callbackUrl: callbackUrl || `${(process.env.APP_URL || 'https://yaard.netlify.app').replace(/\/$/, '')}/ads/payment/callback`,
        metadata: {
          ad_id: adId,
          user_id: userId,
          ad_title: ad.title,
          custom_fields: [
            { display_name: "Ad Title", variable_name: "ad_title", value: ad.title },
            { display_name: "Ad ID", variable_name: "ad_id", value: adId },
          ],
        },
      });

      return success({
        ad,
        payment: {
          reference,
          authorizationUrl: paystackRes.data?.authorization_url,
          accessCode: paystackRes.data?.access_code,
        },
      }, event);
    }

    // POST /:id/impression — Asynchronously increment active operational impressions & allocate spend metrics
    if (path.match(/^\/([a-zA-Z0-9-]+)\/impression$/) && method === "POST") {
      const adId = path.match(/^\/([a-zA-Z0-9-]+)\/impression$/)[1];
      
      // Safety guard check: Only tracks impressions and allocates spend while the banner state layout runs live
      await query(
        `UPDATE ads 
         SET impressions = impressions + 1, 
             spent = spent + (cpm / 1000.0)
         WHERE id = $1 AND status = 'active'`,
        [adId]
      );
      return success({ tracked: true }, event);
    }

    // POST /:id/click — Track and scale explicit dynamic conversions metrics click counters
    if (path.match(/^\/([a-zA-Z0-9-]+)\/click$/) && method === "POST") {
      const adId = path.match(/^\/([a-zA-Z0-9-]+)\/click$/)[1];
      await query("UPDATE ads SET clicks = clicks + 1 WHERE id = $1", [adId]);
      return success({ tracked: true }, event);
    }

    return error("Requested resource endpoint layout route route not found", event, 404);
  } catch (err) {
    console.error("Ads System Error Context:", err);
    // FIXED: Correctly fallback and evaluate framework verification header error properties securely
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal microservice gateway runtime failure", event, statusCode);
  }
}