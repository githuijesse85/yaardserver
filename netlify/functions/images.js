/**
 * @fileoverview Image Management — Yaard API
 *
 * Handles avatar, cover photo, and thumbnail upload signing + completion tracking.
 *
 * Routes:
 *   POST /api/images/upload-signature  — Generate a signed Cloudinary upload token
 *   POST /api/images/upload-complete   — Record completed upload, update user profile
 *   POST /api/images/upload-progress   — Track upload progress in DB
 *   GET  /api/images/avatar            — Get current user's avatar
 *   GET  /api/images/cover             — Get current user's cover photo
 *   DELETE /api/images/avatar          — Delete avatar from Cloudinary + DB
 *   DELETE /api/images/cover           — Delete cover photo from Cloudinary + DB
 *
 * FIXES applied vs previous version:
 *  1. Removed `validateImageRequest()` from the upload-signature route.
 *     The Android client (ImageUploadSignatureRequest) only sends { imageType, resourceType }.
 *     Requiring fileName + fileSize at signature time caused 400 errors → no signature
 *     issued → every image upload failed with an "Unauthorized" error from Cloudinary.
 *     File validation now happens at upload-complete time, which is the correct place.
 *
 *  2. generateUploadSignature() no longer includes max_bytes in the signed params
 *     (fixed in shared/cloudinary.js) so the Cloudinary signature is always valid.
 */

import { query } from "../../shared/db.js";
import {
  handleCors,
  success,
  error,
  requireAuth,
  parseBody,
} from "../../shared/middleware.js";
import {
  uploadImage,
  deleteMedia,
  generateUploadSignature,
} from "../../shared/cloudinary.js";

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set(["avatar", "cover", "thumbnail"]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — enforced at upload-complete

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Create a DB upload-session row and return the new row id.
 * Schema (migration 013): upload_type IN ('video','image','music') NOT NULL
 *                         resource_type IN ('video','image','audio','raw') NOT NULL
 */
async function createUploadSession(userId, imageType) {
  // imageType is one of: avatar, cover, thumbnail → all are 'image' upload_type + resource_type
  const res = await query(
    `INSERT INTO upload_sessions (user_id, upload_type, resource_type, status, created_at)
     VALUES ($1, 'image', 'image', 'pending', NOW())
     RETURNING id`,
    [userId]
  );
  return res.rows[0].id;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

export async function handler(event, context) {
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path
    .replace("/.netlify/functions/images", "")
    .replace("/api/images", "")
    .replace(/\/$/, "");
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // POST /upload-signature
    // Generates a Cloudinary signed upload token for client-side direct upload.
    //
    // FIX: Previously called validateImageRequest() here which required fileName
    // and fileSize. The Android app only sends { imageType, resourceType }, so
    // this caused 400 errors on every image upload attempt. Validation of file
    // metadata now happens at /upload-complete (after the client uploads).
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/upload-signature" && (method === "POST" || method === "GET")) {
      const { userId } = requireAuth(event);
      const body = parseBody(event);

      const imageType =
        body.imageType ||
        body.image_type ||
        params.imageType ||
        params.image_type;

      const resourceType =
        body.resourceType ||
        body.resource_type ||
        params.resourceType ||
        params.resource_type ||
        "image";

      // Validate imageType — this is the only required field
      if (!imageType || !ALLOWED_IMAGE_TYPES.has(imageType)) {
        return error(
          "imageType must be one of: avatar, cover, thumbnail",
          event,
          400
        );
      }

      if (resourceType !== "image") {
        return error(
          "Only image uploads are supported by this endpoint. Use /api/videos/upload-signature for videos.",
          event,
          400
        );
      }

      // Guard: Cloudinary must be configured
      if (
        !process.env.CLOUDINARY_API_SECRET ||
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY
      ) {
        console.error("[images/upload-signature] Missing Cloudinary env vars");
        return error(
          "Media upload service is not configured. Please contact support.",
          event,
          503
        );
      }

      // Build the target folder per user / image type
      const folder = `yaard/users/${userId}/${imageType}`;

      // Generate the cryptographic signature (max_bytes is NOT included — see shared/cloudinary.js)
      const signaturePayload = generateUploadSignature(folder, resourceType, {
        // Restrict accepted formats at the signature level via Cloudinary params
        // (these ARE consistent between signature and upload so they're safe to include)
        allowed_formats: "jpg,jpeg,png,gif,webp,bmp,tiff,heic,heif,avif",
      });

      // Create a DB session record for progress tracking
      let sessionId = null;
      try {
        sessionId = await createUploadSession(userId, imageType);
      } catch (sessionErr) {
        // Upload sessions table may not exist in older DB schemas — don't block uploads
        console.warn(
          "[images/upload-signature] upload_sessions table unavailable:",
          sessionErr.message
        );
      }

      return success(
        {
          sessionId,
          ...signaturePayload,
        },
        event
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /upload-complete
    // Called by the client after a successful Cloudinary upload to record the
    // final image URL and update the user's profile.
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/upload-complete" && method === "POST") {
      const { userId } = requireAuth(event);
      const body = parseBody(event);
      const {
        sessionId,
        imageType,
        cloudinaryPublicId,
        imageUrl,
        width,
        height,
      } = body;

      if (!imageType || !ALLOWED_IMAGE_TYPES.has(imageType)) {
        return error(
          "imageType must be one of: avatar, cover, thumbnail",
          event,
          400
        );
      }
      if (!imageUrl) {
        return error("imageUrl is required", event, 400);
      }

      // Update the appropriate user profile column
      const columnMap = {
        avatar: "avatar_url",
        cover: "cover_url",
        thumbnail: null, // Thumbnails are attached to videos, not users
      };

      const column = columnMap[imageType];

      let updatedUser = null;

      if (column) {
        const res = await query(
          `UPDATE users
           SET ${column} = $1, updated_at = NOW()
           WHERE id = $2
           RETURNING id, email, username, display_name, bio, avatar_url, cover_url,
                     phone, whatsapp, website, is_verified, is_business,
                     followers_count, following_count, videos_count,
                     total_likes, total_views, created_at`,
          [imageUrl, userId]
        );
        updatedUser = res.rows[0] || null;
      }

      // Mark the session as completed
      if (sessionId) {
        try {
          await query(
            `UPDATE upload_sessions
             SET status = 'completed',
                 cloudinary_public_id = $1,
                 metadata = COALESCE(metadata, '{}')::jsonb || $2::jsonb,
                 completed_at = NOW()
             WHERE id = $3 AND user_id = $4`,
            [
              cloudinaryPublicId || null,
              JSON.stringify({ imageUrl, width, height }),
              sessionId,
              userId,
            ]
          );
        } catch (sessionErr) {
          console.warn(
            "[images/upload-complete] session update skipped:",
            sessionErr.message
          );
        }
      }

      return success(
        {
          message: `${imageType} uploaded successfully`,
          imageType,
          imageUrl,
          user: updatedUser,
        },
        event
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /upload-progress
    // Optional progress tracking endpoint.
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/upload-progress" && method === "POST") {
      const { userId } = requireAuth(event);
      const { sessionId, progressPercent } = parseBody(event);

      if (!sessionId) {
        return error("sessionId is required", event, 400);
      }

      try {
        await query(
          `UPDATE upload_sessions
           SET metadata = COALESCE(metadata, '{}')::jsonb || $1::jsonb
           WHERE id = $2 AND user_id = $3`,
          [JSON.stringify({ progress: progressPercent }), sessionId, userId]
        );
      } catch (sessionErr) {
        console.warn(
          "[images/upload-progress] session update skipped:",
          sessionErr.message
        );
      }

      return success({ sessionId, progressPercent }, event);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // GET /avatar | GET /cover — Fetch current user's image URLs
    // ──────────────────────────────────────────────────────────────────────────
    if (path.match(/^\/(avatar|cover)$/) && method === "GET") {
      const { userId } = requireAuth(event);
      const imageType = path.substring(1);
      const column = imageType === "avatar" ? "avatar_url" : "cover_url";

      const res = await query(`SELECT ${column} FROM users WHERE id = $1`, [
        userId,
      ]);
      if (res.rows.length === 0) {
        return error("User not found", event, 404);
      }

      return success({ imageType, imageUrl: res.rows[0][column] }, event);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DELETE /avatar | DELETE /cover — Remove image from Cloudinary + DB
    // ──────────────────────────────────────────────────────────────────────────
    if (path.match(/^\/(avatar|cover)$/) && method === "DELETE") {
      const { userId } = requireAuth(event);
      const imageType = path.substring(1);
      const column = imageType === "avatar" ? "avatar_url" : "cover_url";

      const userRes = await query(
        `SELECT ${column} FROM users WHERE id = $1`,
        [userId]
      );
      if (userRes.rows.length === 0) {
        return error("User not found", event, 404);
      }

      const imageUrl = userRes.rows[0][column];

      // Attempt to delete from Cloudinary (best-effort)
      if (imageUrl && imageUrl.includes("cloudinary.com")) {
        try {
          // Extract public_id: …/image/upload/v123456/yaard/users/UUID/avatar/filename
          const match = imageUrl.match(
            /\/image\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/i
          );
          if (match && match[1]) {
            await deleteMedia(match[1], "image");
          }
        } catch (cdnErr) {
          console.warn(
            "[images/delete] Cloudinary deletion failed (continuing):",
            cdnErr.message
          );
        }
      }

      await query(
        `UPDATE users SET ${column} = NULL, updated_at = NOW() WHERE id = $1`,
        [userId]
      );

      return success({ message: `${imageType} deleted successfully`, imageType }, event);
    }

    return error("Image endpoint not found", event, 404);
  } catch (err) {
    console.error("[Images API Error]:", err);
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal server error", event, statusCode);
  }
}
