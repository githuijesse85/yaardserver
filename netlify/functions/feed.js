import { query } from "../../shared/db.js";
import { handleCors, success, error, requireAuth } from "../../shared/middleware.js";
import { generateStreamingUrls } from "../../shared/cloudinary.js";

/**
 * Enriches videos with adaptive streaming URLs for mobile optimization
 */
function enrichVideosWithStreamingUrls(videos, minimal = true) {
  if (!videos || videos.length === 0) return videos;

  return videos.map((v) => {
    if (!v.video_public_id) return v;

    try {
      const streamingUrls = generateStreamingUrls(v.video_public_id, { minimal });
      return {
        ...v,
        streaming_urls: streamingUrls,
        video_url: streamingUrls.fallback || v.video_url
      };
    } catch (err) {
      console.warn(`[Video ${v.id}] Failed to generate streaming URLs:`, err.message);
      return v;
    }
  });
}

export async function handler(event, context) {
  // CRITICAL FIX: Stops 500/502 Gateway errors caused by serverless event-loop waiting on the DB connection pool
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/feed", "").replace("/api/feed", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // GET / — For You Page (FYP) with optimized N+1 query fix
    if ((path === "" || path === "/") && method === "GET") {
      let currentUserId = null;
      try { 
        const auth = requireAuth(event);
        currentUserId = auth ? auth.userId : null; 
      } catch (e) {
        // Optional auth fallback for anonymous browsing
      }

      const page = Math.max(1, parseInt(params.page) || 1);
      const limit = Math.max(1, parseInt(params.limit) || 10);
      const offset = (page - 1) * limit;

      // OPTIMIZED: Use single query with LEFT JOINs to interaction tables
      // instead of separate queries (N+1 fix). PostgreSQL will handle aggregation.
      const videoRes = await query(
        `SELECT v.*,
                u.username, u.display_name, u.avatar_url, u.is_business, u.is_verified,
                c.name as category_name, c.slug as category_slug,
                (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') as is_ad_slot,
                a.id as advertisement_id,
                a.target_url, a.title as cta_text, a.budget, a.spent,
                EXISTS(SELECT 1 FROM likes l WHERE l.video_id = v.id AND l.user_id = $3) as is_liked,
                EXISTS(SELECT 1 FROM saves s WHERE s.video_id = v.id AND s.user_id = $3) as is_saved,
                EXISTS(SELECT 1 FROM follows f WHERE f.following_id = u.id AND f.follower_id = $3) as is_following
         FROM videos v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN categories c ON c.id = v.category_id
         LEFT JOIN ads a ON a.video_id = v.id
           AND a.status = 'active'
           AND a.payment_status = 'paid'
           AND (a.ends_at IS NULL OR a.ends_at > NOW())
           AND a.spent < a.budget
         WHERE v.status = 'active'
         ORDER BY (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') DESC,
                  (CASE WHEN (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') THEN (a.budget - a.spent) ELSE 0 END) DESC,
                  u.is_verified DESC,
                  v.created_at DESC
         LIMIT $1 OFFSET $2`,        [limit, offset, currentUserId]
      );

      const progressiveRequested = params.progressive === 'true' || params.full_streaming === 'true';
      let feed = enrichVideosWithStreamingUrls(videoRes.rows, !progressiveRequested);

      // Get trending videos (same optimized query pattern)
      const trendingLimit = Math.max(1, Math.min(50, parseInt(params.trendingLimit) || 10));
      const trendingRes = await query(
        `SELECT v.*,
                u.username, u.display_name, u.avatar_url, u.is_business, u.is_verified,
                c.name as category_name, c.slug as category_slug,
                (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') as is_ad_slot,
                a.id as advertisement_id,
                a.target_url, a.title as cta_text, a.budget, a.spent,
                COALESCE(bool_or(l.video_id IS NOT NULL), false) as is_liked,
                COALESCE(bool_or(s.video_id IS NOT NULL), false) as is_saved,
                COALESCE(bool_or(f.following_id IS NOT NULL), false) as is_following
         FROM videos v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN categories c ON c.id = v.category_id
         LEFT JOIN ads a ON a.video_id = v.id 
           AND a.status = 'active'
           AND a.payment_status = 'paid'
           AND (a.ends_at IS NULL OR a.ends_at > NOW())
           AND a.spent < a.budget
         LEFT JOIN likes l ON l.video_id = v.id AND l.user_id = $2
         LEFT JOIN saves s ON s.video_id = v.id AND s.user_id = $2
         LEFT JOIN follows f ON f.following_id = u.id AND f.follower_id = $2
         WHERE v.status = 'active'
         GROUP BY v.id, u.id, c.id, a.id
         ORDER BY (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') DESC,
                  (CASE WHEN (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') THEN (a.budget - a.spent) ELSE 0 END) DESC,
                  u.is_verified DESC,
                  (v.likes_count * 3 + v.views_count) DESC
         LIMIT $1`,        [trendingLimit, currentUserId]
      );

      let trending = enrichVideosWithStreamingUrls(trendingRes.rows, !progressiveRequested);

      return success({ feed, trending, page, limit }, event);
    }

    // GET /following — Following feed with optimized N+1 query fix
    if (path === "/following" && method === "GET") {
      const { userId } = requireAuth(event);
      const page = Math.max(1, parseInt(params.page) || 1);
      const limit = Math.max(1, parseInt(params.limit) || 10);
      const offset = (page - 1) * limit;

      // OPTIMIZED: Use single query with LEFT JOINs instead of separate queries
      const res = await query(
        `SELECT v.*,
                u.username, u.display_name, u.avatar_url, u.is_business, u.is_verified,
                c.name as category_name, c.slug as category_slug,
                COALESCE(bool_or(l.video_id IS NOT NULL), false) as is_liked,
                COALESCE(bool_or(s.video_id IS NOT NULL), false) as is_saved,
                COALESCE(bool_or(f.following_id IS NOT NULL), false) as is_following
         FROM videos v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN categories c ON c.id = v.category_id
         JOIN follows f ON f.following_id = v.user_id
         LEFT JOIN likes l ON l.video_id = v.id AND l.user_id = $1
         LEFT JOIN saves s ON s.video_id = v.id AND s.user_id = $1
         LEFT JOIN follows f2 ON f2.following_id = u.id AND f2.follower_id = $1
         WHERE f.follower_id=$1 AND v.status='active'
         GROUP BY v.id, u.id, c.id
         ORDER BY v.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const progressiveRequested = params.progressive === 'true' || params.full_streaming === 'true';
      let feed = enrichVideosWithStreamingUrls(res.rows, !progressiveRequested);

      return success({ feed, page, limit }, event);
    }

    // GET /trending — Trending videos
    if (path === "/trending" && method === "GET") {
      const category = params.category;
      const page = Math.max(1, parseInt(params.page) || 1);
      const limit = Math.max(1, Math.min(50, parseInt(params.limit) || 10));
      const offset = (page - 1) * limit;

      let whereClause = "WHERE v.status='active'";
      const qParams = [];

      if (category) {
        qParams.push(category);
        whereClause += ` AND c.slug=$${qParams.length}`;
      }

      qParams.push(limit, offset);

      const res = await query(
        `SELECT v.*,
                u.username, u.display_name, u.avatar_url, u.is_business, u.is_verified,
                c.name as category_name, c.slug as category_slug,
                (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') as is_ad_slot,
                a.id as advertisement_id,
                a.target_url, a.title as cta_text, a.budget, a.spent
         FROM videos v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN categories c ON c.id = v.category_id
         LEFT JOIN ads a ON a.video_id = v.id
           AND a.status = 'active'
           AND a.payment_status = 'paid'
           AND a.spent < a.budget
         ${whereClause}
         ORDER BY (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') DESC,
                  (CASE WHEN (a.id IS NOT NULL AND a.status = 'active' AND a.payment_status = 'paid') THEN (a.budget - a.spent) ELSE 0 END) DESC,
                  u.is_verified DESC,
                  COALESCE(v.likes_count, 0) * 3 + COALESCE(v.views_count, 0) DESC
         LIMIT $${qParams.length - 1} OFFSET $${qParams.length}`,
        qParams
      );

      return success(res.rows, event);
    }

    // GET /saved — User's saved videos
    if (path === "/saved" && method === "GET") {
      const { userId } = requireAuth(event);
      const res = await query(
        `SELECT v.*,
                u.username, u.display_name, u.avatar_url, u.is_business, u.is_verified,
                c.name as category_name
         FROM saves s
         JOIN videos v ON v.id = s.video_id
         JOIN users u ON u.id = v.user_id
         LEFT JOIN categories c ON c.id = v.category_id
         WHERE s.user_id=$1 AND v.status='active'
         ORDER BY s.created_at DESC`,
        [userId]
      );
      return success(res.rows, event);
    }

    // GET /categories — All categories with counts
    if (path === "/categories" && method === "GET") {
      const res = await query(
        `SELECT c.*, COUNT(v.id) as video_count
         FROM categories c
         LEFT JOIN videos v ON v.category_id = c.id AND v.status='active'
         GROUP BY c.id
         ORDER BY c.sort_order ASC`
      );
      return success(res.rows, event);
    }

    // GET /music — Trending music tracks
    if (path === "/music" && method === "GET") {
      const res = await query(
        "SELECT * FROM music_tracks ORDER BY is_trending DESC, use_count DESC LIMIT 50"
      );
      return success(res.rows, event);
    }

    return error("Route not found", event, 404);
  } catch (err) {
    console.error("Feed error:", err);
    // FIXED: Maps to standard err.statusCode securely to catch authentication failures (401)
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal server error", event, statusCode);
  }
}