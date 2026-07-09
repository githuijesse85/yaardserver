import { query } from "../../shared/db";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware";

export async function handler(event, context) {
  // CRITICAL FIX: Directs Netlify to immediately release processing loops,
  // preventing active idle connection pools from causing function timeouts.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/comments", "").replace("/api/comments", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // URL Context Route Regex Parsers
    const videoMatch = path.match(/^\/video\/([a-zA-Z0-9-]+)$/);
    const commentMatch = path.match(/^\/([a-zA-Z0-9-]+)$/);
    const likeMatch = path.match(/^\/([a-zA-Z0-9-]+)\/like$/);

    // ─────────────────────────────────────────────────────────────────────────
    // GET /video/:videoId — Unified Comment Tree Stream Engine
    // ─────────────────────────────────────────────────────────────────────────
    if (videoMatch && method === "GET") {
      const videoId = videoMatch[1];
      const page = Math.max(1, parseInt(params.page, 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(params.limit, 10) || 30));
      const offset = (page - 1) * limit;

      let currentUserId = null;
      try { 
        currentUserId = requireAuth(event).userId; 
      } catch {
        // Capture unauthenticated viewers silently to deliver generic interaction streams
      }

      // Phase 1: Retrieve top-level parent comments
      const res = await query(
        `SELECT c.*, u.username, u.display_name, u.avatar_url, u.is_verified
         FROM comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.video_id = $1 AND c.parent_id IS NULL
         ORDER BY c.created_at DESC
         LIMIT $2 OFFSET $3`,
        [videoId, limit, offset]
      );

      const rootComments = res.rows;
      const commentIds = rootComments.map((c) => c.id);
      let withReplies = rootComments;

      // Phase 2: Batch extract child replies concurrently via index lookups
      if (commentIds.length > 0) {
        const repliesRes = await query(
          `SELECT c.*, u.username, u.display_name, u.avatar_url, u.is_verified
           FROM comments c
           JOIN users u ON u.id = c.user_id
           WHERE c.parent_id = ANY($1)
           ORDER BY c.created_at ASC`,
          [commentIds]
        );

        const repliesMap = {};
        repliesRes.rows.forEach((r) => {
          if (!repliesMap[r.parent_id]) repliesMap[r.parent_id] = [];
          repliesMap[r.parent_id].push(r);
        });

        withReplies = rootComments.map((c) => ({
          ...c,
          replies: repliesMap[c.id] || [],
        }));
      }

      // Phase 3: Hydrate personalized interaction liked flags if session exists
      if (currentUserId && withReplies.length > 0) {
        const allIds = withReplies.flatMap((c) => [c.id, ...(c.replies || []).map((r) => r.id)]);
        
        const likedRes = await query(
          "SELECT comment_id FROM comment_likes WHERE user_id = $1 AND comment_id = ANY($2)",
          [currentUserId, allIds]
        );
        const likedSet = new Set(likedRes.rows.map((r) => r.comment_id));

        withReplies = withReplies.map((c) => ({
          ...c,
          is_liked: likedSet.has(c.id),
          replies: (c.replies || []).map((r) => ({ ...r, is_liked: likedSet.has(r.id) })),
        }));
      }

      return success({ comments: withReplies, page, limit }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST / — Structural Comment Record Intake Router
    // ─────────────────────────────────────────────────────────────────────────
    if ((path === "" || path === "/") && method === "POST") {
      const { userId } = requireAuth(event);
      const { videoId, content, parentId } = parseBody(event);

      if (!videoId || !content || !String(content).trim()) {
        return error("Target video identifiers and textual message parameters are required.", event, 400);
      }

      // PERFORMANCE OPTIMIZATION: Write entry and join user profiles in 1 single database trip via CTE
      const res = await query(
        `WITH inserted_comment AS (
           INSERT INTO comments (user_id, video_id, content, parent_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *
         )
         SELECT ic.*, u.username, u.display_name, u.avatar_url, u.is_verified
         FROM inserted_comment ic
         JOIN users u ON u.id = ic.user_id`,
        [userId, videoId, String(content).trim(), parentId || null]
      );

      // Async update metrics pool without blocking lifecycle main thread
      query("UPDATE videos SET comments_count = comments_count + 1 WHERE id = $1", [videoId]).catch(() => {});

      return success(res.rows[0], event, 201);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /:id — Target Record Eviction Routing Engine
    // ─────────────────────────────────────────────────────────────────────────
    if (commentMatch && method === "DELETE") {
      const { userId } = requireAuth(event);
      const commentId = commentMatch[1];

      const res = await query(
        "DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING video_id",
        [commentId, userId]
      );
      
      if (res.rows.length === 0) {
        return error("Comment not found or missing structural security update clearances.", event, 403);
      }

      // Sync counter downward bounded to zero ceiling safety limits
      await query(
        "UPDATE videos SET comments_count = GREATEST(0, comments_count - 1) WHERE id = $1",
        [res.rows[0].video_id]
      );
      
      return success({ deleted: true }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /:id/like — Engagement Index Increment Mutation Node
    // ─────────────────────────────────────────────────────────────────────────
    if (likeMatch && method === "POST") {
      const { userId } = requireAuth(event);
      const commentId = likeMatch[1];

      const insert = await query(
        "INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        [userId, commentId]
      );

      if (insert.rows.length === 0) {
        // Conflict caught implies duplicate request processing. Halt mutation, return state safely.
        const cur = await query("SELECT likes_count FROM comments WHERE id = $1", [commentId]);
        return success({ likes_count: cur.rows[0]?.likes_count ?? 0 }, event);
      }

      const res = await query(
        "UPDATE comments SET likes_count = likes_count + 1 WHERE id = $1 RETURNING likes_count",
        [commentId]
      );
      return success({ likes_count: res.rows[0]?.likes_count ?? 0 }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /:id/like — Engagement Index Decrement Mutation Node
    // ─────────────────────────────────────────────────────────────────────────
    if (likeMatch && method === "DELETE") {
      const { userId } = requireAuth(event);
      const commentId = likeMatch[1];

      const del = await query(
        "DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2 RETURNING id",
        [userId, commentId]
      );

      if (del.rows.length === 0) {
        // Entry missing handles pre-existing zero-liked matrix conditions safely
        const cur = await query("SELECT likes_count FROM comments WHERE id = $1", [commentId]);
        return success({ likes_count: cur.rows[0]?.likes_count ?? 0 }, event);
      }

      const res = await query(
        "UPDATE comments SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1 RETURNING likes_count",
        [commentId]
      );
      return success({ likes_count: res.rows[0]?.likes_count ?? 0 }, event);
    }

    return error("Requested response message stream route context map not found.", event, 404);
  } catch (err) {
    console.error("Centralized Comments Subsystem Architecture Exception:", err);
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal database feedback channel pipeline crash", event, statusCode);
  }
}