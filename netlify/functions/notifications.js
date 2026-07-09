/**
 * Mobile Push Notifications System
 * Handles notification delivery, storage, and management for mobile apps
 * Enhanced with upload progress tracking and batch operations
 */

import { query } from "../../shared/db";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware";

export async function handler(event, context) {
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/notifications", "").replace("/api/notifications", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // GET / — List user notifications with pagination
    // ─────────────────────────────────────────────────────────────────────────
    if ((path === "" || path === "/") && method === "GET") {
      const { userId } = requireAuth(event);
      const page = Math.max(1, parseInt(params.page, 10) || 1);
      const limit = Math.max(1, Math.min(50, parseInt(params.limit, 10) || 20));
      const offset = (page - 1) * limit;
      const unreadOnly = params.unread === "true";

      let whereClause = "WHERE user_id = $1";
      const sqlParams = [userId];

      if (unreadOnly) {
        whereClause += " AND is_read = FALSE";
      }

      const res = await query(
        `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`,
        [...sqlParams, limit, offset]
      );

      const countRes = await query(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN is_read = FALSE THEN 1 END) as unread
         FROM notifications
         ${whereClause}`,
        sqlParams
      );

      return success({
        notifications: res.rows,
        pagination: {
          page,
          limit,
          total: countRes.rows[0].total,
          unread: countRes.rows[0].unread
        }
      }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /unread-count — Get count of unread notifications
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/unread-count" && method === "GET") {
      const { userId } = requireAuth(event);

      const res = await query(
        "SELECT COUNT(*) as unread FROM notifications WHERE user_id = $1 AND is_read = FALSE",
        [userId]
      );

      return success({
        unreadCount: res.rows[0].unread
      }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST / — Create new notification (Admin/System use)
    // ─────────────────────────────────────────────────────────────────────────
    if ((path === "" || path === "/") && method === "POST") {
      const body = parseBody(event);
      const { userId, type, title, bodyText, data } = body;

      if (!userId || !type || !title) {
        return error("userId, type, and title are required", event, 400);
      }

      const validTypes = [
        "upload_started", "upload_progress", "upload_completed", "upload_failed",
        "comment", "like", "follow", "reply", "message", "ad", "payment",
        "new_video", "new_ad"
      ];
      if (!validTypes.includes(type)) {
        return error(`type must be one of: ${validTypes.join(", ")}`, event, 400);
      }

      const res = await query(
        `INSERT INTO notifications (user_id, type, title, body, data)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, type, title, body, data, is_read, created_at`,
        [userId, type, title, bodyText || null, data ? JSON.stringify(data) : null]
      );

      return success(res.rows[0], event, 201);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUT /:id/read — Mark notification as read
    // ─────────────────────────────────────────────────────────────────────────
    if (path.match(/^\/([a-zA-Z0-9-]+)\/read$/) && method === "PUT") {
      const { userId } = requireAuth(event);
      const notificationId = path.match(/^\/([a-zA-Z0-9-]+)\/read$/)[1];

      const res = await query(
        `UPDATE notifications
         SET is_read = TRUE
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [notificationId, userId]
      );

      if (res.rows.length === 0) {
        return error("Notification not found", event, 404);
      }

      return success(res.rows[0], event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUT /read-all — Mark all notifications as read
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/read-all" && method === "PUT") {
      const { userId } = requireAuth(event);

      await query(
        `UPDATE notifications
         SET is_read = TRUE
         WHERE user_id = $1 AND is_read = FALSE`,
        [userId]
      );

      return success({
        message: "All notifications marked as read"
      }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /delete-all — Clear all notifications  (must come BEFORE /:id)
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/delete-all" && method === "DELETE") {
      const { userId } = requireAuth(event);

      await query(
        "DELETE FROM notifications WHERE user_id = $1",
        [userId]
      );

      return success({
        message: "All notifications deleted"
      }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /:id — Delete specific notification
    // ─────────────────────────────────────────────────────────────────────────
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === "DELETE") {
      const { userId } = requireAuth(event);
      const notificationId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];

      const res = await query(
        "DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id",
        [notificationId, userId]
      );

      if (res.rows.length === 0) {
        return error("Notification not found", event, 404);
      }

      return success({ deleted: true }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /by-type/:type — Get notifications by type
    // ─────────────────────────────────────────────────────────────────────────
    if (path.match(/^\/by-type\/(.+)$/) && method === "GET") {
      const { userId } = requireAuth(event);
      const type = path.match(/^\/by-type\/(.+)$/)[1];
      const limit = Math.min(50, parseInt(params.limit, 10) || 20);

      const res = await query(
        `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications
         WHERE user_id = $1 AND type = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [userId, type, limit]
      );

      return success(res.rows, event);
    }

    return error("Notification endpoint not found", event, 404);

  } catch (err) {
    console.error("Notifications error:", err);
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal server error", event, statusCode);
  }
}