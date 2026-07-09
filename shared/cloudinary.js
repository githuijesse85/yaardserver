/**
 * @fileoverview Shared Cloudinary integration for Yaard API.
 *
 * Key design decisions:
 *  - generateUploadSignature() MUST NOT include max_bytes / max_file_size in
 *    the signed parameter set. Cloudinary computes the HMAC over the exact set
 *    of params the client will re-send during the actual upload. If the backend
 *    signs a payload containing max_bytes but the Android SDK does not echo it
 *    back, the signature will not match → HTTP 401 "Unauthorized" from Cloudinary.
 *  - Size / format enforcement is the client's responsibility before uploading,
 *    or can be enforced via Cloudinary Upload Presets (recommended for production).
 */

import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";

// ── SDK CONFIGURATION ─────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export { cloudinary };

// ── UPLOAD SIGNATURE ──────────────────────────────────────────────────────────

/**
 * Generate a Cloudinary signed upload token for client-side direct uploads.
 *
 * CRITICAL FIX: max_bytes and max_file_size are intentionally excluded from
 * the signed parameter set. Including them causes an "Unauthorized" error from
 * Cloudinary because Android/iOS SDKs do not include those params in the
 * multipart upload request, making the server-computed signature invalid.
 *
 * Enforce upload size limits server-side via upload_complete validation or via
 * a Cloudinary Upload Preset (set max_file_size there instead).
 *
 * @param {string} folder        - Target Cloudinary folder path
 * @param {string} [resourceType='video'] - 'video' | 'image' | 'raw' | 'auto'
 * @param {object} [extra={}]    - Additional params to include in the signature
 *                                 (e.g. allowed_formats, tags, context).
 *                                 max_bytes / max_file_size are stripped even if passed.
 * @returns {{ signature, timestamp, api_key, apiKey, cloud_name, cloudName, folder, resource_type, resourceType }}
 */
export function generateUploadSignature(folder, resourceType = "video", extra = {}) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

  if (!apiSecret || !apiKey || !cloudName) {
    const err = new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, " +
        "and CLOUDINARY_API_SECRET in your environment variables."
    );
    err.statusCode = 503;
    throw err;
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Build the params object — order doesn't matter here, we sort below
  const params = {
    folder,
    resource_type: resourceType,
    timestamp,
    ...extra,
  };

  // ── FIX: Strip any size-limit params that break client-upload signatures ──
  delete params.max_bytes;
  delete params.max_file_size;

  // Cloudinary signature algorithm: sort keys alphabetically, join as key=value&…,
  // append the API secret, then SHA-1 hash (Cloudinary uses SHA-1 by default).
  const sortedKeys = Object.keys(params).sort();
  const stringToSign = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");

  const signature = crypto
    .createHash("sha1")
    .update(stringToSign + apiSecret)
    .digest("hex");

  return {
    // Cloudinary SDK / upload API fields (snake_case)
    signature,
    timestamp,
    api_key: apiKey,
    cloud_name: cloudName,
    folder,
    resource_type: resourceType,
    // Convenience camelCase aliases for Android / iOS clients
    apiKey,
    cloudName,
    resourceType,
  };
}

// ── STREAMING URL HELPERS ─────────────────────────────────────────────────────

/**
 * Derive adaptive streaming and progressive download URLs from a Cloudinary public ID.
 * Returns a structured object matching the Android `StreamingUrls` data class.
 *
 * @param {string} publicId - The Cloudinary video public ID (no extension)
 * @param {{ minimal?: boolean }} [options]
 *   minimal: when true, skip progressive variants (saves bandwidth for feed thumbnails)
 * @returns {{ hls: string, progressive: { high, medium, low }, thumbnail: string, fallback: string }}
 */
export function generateStreamingUrls(publicId, { minimal = false } = {}) {
  if (!publicId) throw new Error("publicId is required");

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) throw new Error("CLOUDINARY_CLOUD_NAME is not configured");

  const base = `https://res.cloudinary.com/${cloudName}`;

  // HLS adaptive stream
  const hls = `${base}/video/upload/sp_hd/${publicId}.m3u8`;

  // Thumbnail (auto-generated frame from the video)
  const thumbnail = `${base}/video/upload/so_0,f_jpg,q_auto,w_720/${publicId}.jpg`;

  // Direct progressive fallback (no transformation)
  const fallback = `${base}/video/upload/q_auto/${publicId}.mp4`;

  if (minimal) {
    return { hls, progressive: null, thumbnail, fallback };
  }

  const progressive = {
    high: `${base}/video/upload/q_auto:good,w_1080/${publicId}.mp4`,
    medium: `${base}/video/upload/q_auto:eco,w_720/${publicId}.mp4`,
    low: `${base}/video/upload/q_auto:low,w_480/${publicId}.mp4`,
  };

  return { hls, progressive, thumbnail, fallback };
}

// ── UPLOAD HELPER ─────────────────────────────────────────────────────────────

/**
 * Upload a base64 or URL image to Cloudinary via the server-side SDK.
 * Used for optional server-side uploads (avatar resizing, etc.).
 *
 * @param {string} fileData    - base64 data URI or remote URL
 * @param {object} [options]   - Cloudinary upload options (folder, public_id, …)
 * @returns {Promise<object>}  - Cloudinary upload result
 */
export async function uploadImage(fileData, options = {}) {
  const defaults = {
    resource_type: "image",
    folder: options.folder || "yaard/images",
    overwrite: true,
    quality: "auto",
    fetch_format: "auto",
  };
  return cloudinary.uploader.upload(fileData, { ...defaults, ...options });
}

// ── DELETE HELPER ─────────────────────────────────────────────────────────────

/**
 * Delete a Cloudinary asset by public ID.
 *
 * @param {string} publicId    - The Cloudinary public ID to delete
 * @param {string} [resourceType='image'] - 'image' | 'video' | 'raw'
 * @returns {Promise<object>}
 */
export async function deleteMedia(publicId, resourceType = "image") {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
