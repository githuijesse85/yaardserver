import { query } from "../../shared/db.js";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware.js";
import { generateUploadSignature } from "../../shared/cloudinary.js";

const ALLOWED_AUDIO_FORMATS = new Set(["mp3", "aac", "m4a", "wav", "ogg", "oga", "flac", "wma", "amr", "aiff", "3gp", "m4b"]);
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/aac", "audio/mp4", "audio/m4a", "audio/x-wav",
  "audio/wav", "audio/ogg", "audio/oga", "audio/flac", "audio/x-ms-wma",
  "audio/amr", "audio/aiff", "audio/x-aiff", "audio/3gpp"
]);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function normalizeAudioMetadata(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim();
  return String(value);
}

function validateAudioRequest(body = {}) {
  const fileName = normalizeAudioMetadata(body.fileName || body.file_name || body.name) || "";
  const mimeType = normalizeAudioMetadata(body.mimeType || body.mime_type || body.contentType || body.content_type) || "";
  const sizeBytes = Number(body.fileSize || body.file_size || body.size || 0);

  if (!fileName) {
    return { valid: false, message: "fileName is required" };
  }

  const lowerName = fileName.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.split(".").pop() : "";
  const hasAllowedExtension = extension && ALLOWED_AUDIO_FORMATS.has(extension);
  const hasAllowedMime = mimeType && ALLOWED_AUDIO_MIME_TYPES.has(mimeType.toLowerCase());

  if (!hasAllowedExtension && !hasAllowedMime) {
    return { valid: false, message: `Unsupported audio file. Allowed formats: ${Array.from(ALLOWED_AUDIO_FORMATS).join(", ")}` };
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { valid: false, message: "fileSize is required" };
  }

  if (sizeBytes > MAX_AUDIO_BYTES) {
    return { valid: false, message: "Audio file exceeds the 20MB limit" };
  }

  return { valid: true };
}

async function createUploadSession(userId, fileName) {
  try {
    return await query(
      `INSERT INTO upload_sessions (user_id, upload_type, resource_type, filename, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, "music", "audio", fileName || "audio", "pending"]
    );
  } catch (err) {
    const message = String(err?.message || "");
    if (message.includes("check constraint") || message.includes("violates check constraint") || message.includes("does not exist")) {
      try {
        return await query(
          `INSERT INTO upload_sessions (user_id, upload_type, resource_type, filename, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, "music", "raw", fileName || "audio", "pending"]
        );
      } catch (fallbackErr) {
        console.warn("[music/upload-signature] upload session insert failed, continuing without a session", fallbackErr.message);
        return { rows: [{ id: null }] };
      }
    }
    throw err;
  }
}

export async function handler(event, context) {
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/music", "").replace("/api/music", "");
  const method = event.httpMethod;
  const body = parseBody(event);
  const params = event.queryStringParameters || {};

  try {
    if (path === "/upload-signature" && (method === "POST" || method === "GET")) {
      const { userId } = requireAuth(event);
      const payload = method === "GET" ? params : body;
      const validation = validateAudioRequest(payload);
      if (!validation.valid) {
        return error(validation.message, event, 400);
      }

      if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) {
        return error("Media upload service is not configured. Please contact support.", event, 503);
      }

      const folder = payload.folder || params.folder || `yaard/users/${userId}/music`;
      const resourceType = payload.resourceType || payload.resource_type || params.resourceType || params.resource_type || "raw";
      const normalizedResourceType = String(resourceType || "raw").toLowerCase();
      const sig = generateUploadSignature(folder, normalizedResourceType, {
        allowed_formats: Array.from(ALLOWED_AUDIO_FORMATS).join(",")
      });

      const sessionRes = await createUploadSession(userId, payload.fileName || payload.file_name || "audio");

      return success({ sessionId: sessionRes.rows[0].id, ...sig }, event);
    }

    if (path === "/upload-complete" && method === "POST") {
      const { userId } = requireAuth(event);
      const payload = parseBody(event);
      const { sessionId, cloudinaryPublicId, audioUrl, duration, format, mimeType } = payload;

      if (!audioUrl) {
        return error("audioUrl is required", event, 400);
      }

      const hasSessionId = sessionId !== undefined && sessionId !== null && String(sessionId).trim() !== "" && String(sessionId) !== "0";

      if (hasSessionId) {
        try {
          const sessionRes = await query(
            "SELECT id FROM upload_sessions WHERE id = $1 AND user_id = $2",
            [sessionId, userId]
          );

          if (sessionRes.rows.length > 0) {
            await query(
              `UPDATE upload_sessions
               SET status = $1, cloudinary_public_id = $2, metadata = COALESCE(metadata, '{}')::jsonb || $3::jsonb, completed_at = NOW()
               WHERE id = $4`,
              ["completed", cloudinaryPublicId || null, JSON.stringify({ audioUrl, duration, format, mimeType }), sessionId]
            );
          }
        } catch (sessionErr) {
          console.warn("[music/upload-complete] upload session update skipped", sessionErr.message);
        }
      }

      return success({ message: "Music upload completed successfully", sessionId: hasSessionId ? sessionId : null, audioUrl, publicId: cloudinaryPublicId || null }, event, 201);
    }

    return error("Not found", event, 404);
  } catch (err) {
    return error(err.message || "Music upload failed", event, err.statusCode || 500);
  }
}
