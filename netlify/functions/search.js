import { query } from "../../shared/db.js";
import { handleCors, success, error } from "../../shared/middleware.js";

export async function handler(event, context) {
  // CRITICAL FIX: Releases processing loops instantly, preventing active 
  // idle connection pools from triggering Netlify function timeouts.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/search", "").replace("/api/search", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  if (method !== "GET") {
    return error("Method not allowed on this endpoint matrix.", event, 405);
  }

  try {
    const q = (params.q || "").trim();
    const type = params.type || "all";

    if (!q) {
      return error("Search execution requires a non-empty query parameter string.", event, 400);
    }

    // Prepare wildcards for pattern matching and enforce lowcase normalization
    const wildcardParam = `%${q}%`;
    const canonicalTag = q.toLowerCase();

    const results = {};
    const tasks = [];
    const taskKeys = [];

    // ─────────────────────────────────────────────────────────────────────────
    // Task Vector Assignment: Videos Processing
    // ─────────────────────────────────────────────────────────────────────────
    if (type === "all" || type === "videos") {
      taskKeys.push("videos");
      tasks.push(
        query(
          `SELECT v.id, v.title, v.thumbnail_url, v.views_count, v.likes_count, v.duration,
                  v.price, v.currency, v.location_city, v.created_at,
                  u.username, u.display_name, u.avatar_url, u.is_verified, u.is_business,
                  c.name AS category_name, c.slug AS category_slug,
                  (a.id IS NOT NULL) as is_ad_slot, a.id as advertisement_id,
                  a.target_url, a.title as cta_text, a.budget, a.cpm
           FROM videos v
           JOIN users u ON u.id = v.user_id
           LEFT JOIN LATERAL (
             SELECT *
             FROM ads a
             WHERE a.video_id = v.id
               AND a.status = 'active'
               AND a.payment_status = 'paid'
               AND (a.ends_at IS NULL OR a.ends_at > NOW())
               AND a.spent < a.budget
             ORDER BY a.budget DESC
             LIMIT 1
           ) a ON true
           LEFT JOIN categories c ON c.id = v.category_id
           WHERE v.status = 'active'
             AND (
               v.title ILIKE $1 OR 
               v.description ILIKE $1 OR 
               $2 = ANY(v.tags)
             )
           ORDER BY is_ad_slot DESC, u.is_verified DESC, u.is_business DESC, COALESCE(a.budget, 0) DESC, (v.likes_count * 3 + v.views_count) DESC, v.created_at DESC
           LIMIT 20`,
          [wildcardParam, canonicalTag]
        )
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Task Vector Assignment: Users Processing
    // ─────────────────────────────────────────────────────────────────────────
    if (type === "all" || type === "users") {
      taskKeys.push("users");
      tasks.push(
        query(
          `SELECT id, username, display_name, avatar_url, is_verified, followers_count, bio
           FROM users
           WHERE username ILIKE $1 OR display_name ILIKE $1
           ORDER BY followers_count DESC, username ASC
           LIMIT 20`,
          [wildcardParam]
        )
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Task Vector Assignment: Hashtags Processing
    // ─────────────────────────────────────────────────────────────────────────
    if (type === "all" || type === "hashtags") {
      taskKeys.push("hashtags");
      tasks.push(
        query(
          `SELECT LOWER(tag) AS tag, COUNT(*) AS count
           FROM (
             SELECT unnest(tags) AS tag
             FROM videos
             WHERE status = 'active'
           ) AS unnested_dataset
           WHERE tag ILIKE $1
           GROUP BY LOWER(tag)
           ORDER BY count DESC, tag ASC
           LIMIT 20`,
          [wildcardParam]
        )
      );
    }

    // Resolve structural indices concurrently to maximize throughput
    const queryResponses = await Promise.all(tasks);

    // Hydrate dataset map structures matching the operational key layout
    taskKeys.forEach((key, index) => {
      results[key] = queryResponses[index].rows;
    });

    // Keep initial empty fields structured safely if specific single target values were requested
    if (type !== "all") {
      const standardKeys = ["videos", "users", "hashtags"];
      standardKeys.forEach((key) => {
        if (!results[key]) results[key] = [];
      });
    }

    return success({ query: q, results }, event);
  } catch (err) {
    console.error("Centralized Search Architecture Vector Exception:", err);
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal context database search evaluation breakdown", event, statusCode);
  }
}