import { query } from "../../shared/db";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware";

export async function handler(event, context) {
  // CRITICAL FIX: Prevents idle DB connection pool from hanging the handler thread.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/users", "").replace("/api/users", "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // GET /me — current user profile
    if (path === "/me" && method === "GET") {
      const { userId } = requireAuth(event);
      const res = await query(
        `SELECT id, email, username, display_name, bio, avatar_url, cover_url,
                phone, whatsapp, website, location,
                is_verified, is_business, followers_count, following_count,
                videos_count, total_likes, total_views, created_at
         FROM users WHERE id=$1`,
        [userId]
      );
      if (res.rows.length === 0) return error("User not found", event, 404);
      return success(res.rows[0], event);
    }

    // PUT /me — update profile
    if (path === "/me" && method === "PUT") {
      const { userId } = requireAuth(event);
      const { displayName, bio, avatarUrl, coverUrl, phone, whatsapp, website } = parseBody(event);

      const res = await query(
        `UPDATE users SET
           display_name=COALESCE($1, display_name),
           bio=COALESCE($2, bio),
           avatar_url=COALESCE($3, avatar_url),
           cover_url=COALESCE($4, cover_url),
           phone=COALESCE($5, phone),
           whatsapp=COALESCE($6, whatsapp),
           website=COALESCE($7, website),
           updated_at=NOW()
         WHERE id=$8
         RETURNING id, email, username, display_name, bio, avatar_url, cover_url,
                   phone, whatsapp, website, location,
                   is_verified, is_business, followers_count, following_count,
                   videos_count, total_likes, total_views, created_at`,
        [displayName, bio, avatarUrl, coverUrl, phone, whatsapp, website, userId]
      );
      return success(res.rows[0], event);
    }

    // POST /me/change-email — request email change (sends verification to new address)
    if (path === "/me/change-email" && method === "POST") {
      const { userId } = requireAuth(event);
      const { newEmail, password } = parseBody(event);

      if (!newEmail || !password) {
        return error("newEmail and password are required", event, 400);
      }

      const cleanEmail = String(newEmail).trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        return error("Invalid email address format", event, 400);
      }

      // Check email is not already taken
      const existing = await query("SELECT id FROM users WHERE email = $1 AND id != $2", [cleanEmail, userId]);
      if (existing.rows.length > 0) {
        return error("This email address is already in use", event, 409);
      }

      // Verify current password
      const { compare } = await import("bcryptjs");
      const userRes = await query("SELECT password_hash FROM users WHERE id = $1", [userId]);
      if (userRes.rows.length === 0) return error("User not found", event, 404);

      const valid = await compare(password, userRes.rows[0].password_hash);
      if (!valid) return error("Incorrect password", event, 401);

      // Update email and mark as unverified (requires re-verification)
      const { v4: uuidv4 } = await import("uuid");
      const verificationToken = uuidv4();
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await query(
        `UPDATE users SET
           email = $1,
           is_verified = FALSE,
           email_verification_token = $2,
           email_verification_expires = $3,
           updated_at = NOW()
         WHERE id = $4`,
        [cleanEmail, verificationToken, verificationExpires, userId]
      );

      // Send verification email to new address (non-fatal)
      try {
        const { sendVerificationEmail } = await import("../../shared/email.js");
        const userInfo = await query("SELECT username FROM users WHERE id = $1", [userId]);
        await sendVerificationEmail(cleanEmail, userInfo.rows[0]?.username || "User", verificationToken);
      } catch (emailErr) {
        console.warn("[change-email] Failed to send verification email:", emailErr.message);
      }

      return success({ message: "Email updated. Please verify your new address." }, event);
    }

    // GET /search?q=...
    if (path === "/search" && method === "GET") {
      const q = params.q || "";
      const res = await query(
        `SELECT id, username, display_name, avatar_url, is_verified, followers_count, is_business
         FROM users
         WHERE username ILIKE $1 OR display_name ILIKE $1
         LIMIT 30`,
        [`%${q}%`]
      );
      return success(res.rows, event);
    }

    // GET /:username — public profile
    const usernameMatch = path.match(/^\/([^\/]+)$/);
    if (usernameMatch && method === "GET") {
      const username = usernameMatch[1];
      let currentUserId = null;
      try { currentUserId = requireAuth(event).userId; } catch {}

      const res = await query(
        `SELECT id, username, display_name, bio, avatar_url, cover_url,
                phone, whatsapp, website, location,
                is_verified, is_business, followers_count, following_count,
                videos_count, total_likes, total_views, created_at
         FROM users WHERE username=$1`,
        [username]
      );
      if (res.rows.length === 0) return error("User not found", event, 404);
      const user = res.rows[0];

      let is_following = false;
      if (currentUserId) {
        const followRes = await query(
          "SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2",
          [currentUserId, user.id]
        );
        is_following = followRes.rows.length > 0;
      }

      return success({ ...user, is_following }, event);
    }

    // POST /:userId/follow
    const followMatch = path.match(/^\/([a-zA-Z0-9-]+)\/follow$/);
    if (followMatch && method === "POST") {
      const { userId } = requireAuth(event);
      const targetId = followMatch[1];

      if (userId === targetId) return error("Cannot follow yourself", event);

      try {
        await query(
          "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [userId, targetId]
        );
        await query("UPDATE users SET followers_count = followers_count + 1 WHERE id=$1", [targetId]);
        await query("UPDATE users SET following_count = following_count + 1 WHERE id=$1", [userId]);
        return success({ following: true }, event);
      } catch {
        return error("Failed to follow user", event);
      }
    }

    // DELETE /:userId/follow
    if (path.match(/^\/([a-zA-Z0-9-]+)\/follow$/) && method === "DELETE") {
      const { userId } = requireAuth(event);
      const targetId = path.match(/^\/([a-zA-Z0-9-]+)\/follow$/)[1];

      await query(
        "DELETE FROM follows WHERE follower_id=$1 AND following_id=$2",
        [userId, targetId]
      );
      await query("UPDATE users SET followers_count = GREATEST(0, followers_count - 1) WHERE id=$1", [targetId]);
      await query("UPDATE users SET following_count = GREATEST(0, following_count - 1) WHERE id=$1", [userId]);
      return success({ following: false }, event);
    }

    // GET /:userId/followers
    if (path.match(/^\/([a-zA-Z0-9-]+)\/followers$/) && method === "GET") {
      const targetId = path.match(/^\/([a-zA-Z0-9-]+)\/followers$/)[1];
      const res = await query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, u.is_business
         FROM follows f JOIN users u ON u.id = f.follower_id
         WHERE f.following_id=$1 ORDER BY f.created_at DESC LIMIT 50`,
        [targetId]
      );
      return success(res.rows, event);
    }

    // GET /:userId/following
    if (path.match(/^\/([a-zA-Z0-9-]+)\/following$/) && method === "GET") {
      const targetId = path.match(/^\/([a-zA-Z0-9-]+)\/following$/)[1];
      const res = await query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, u.is_business
         FROM follows f JOIN users u ON u.id = f.following_id
         WHERE f.follower_id=$1 ORDER BY f.created_at DESC LIMIT 50`,
        [targetId]
      );
      return success(res.rows, event);
    }

    return error("Route not found", event, 404);
  } catch (err) {
    console.error("Users error:", err);
    return error(err.message || "Internal server error", event, err.status || 500);
  }
}
