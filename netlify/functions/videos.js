import { query } from "../../shared/db.js";
import { handleCors, success, error, requireAuth, parseBody } from "../../shared/middleware.js";
import { generateUploadSignature, generateStreamingUrls } from "../../shared/cloudinary.js";
import { sendReportToAdmin } from "../../shared/email.js";

const ALLOWED_PRICE_MODES = new Set(['actual', 'from', 'reserved', 'on_request']);

// starts_at/ends_at are DATE columns (migration 010), fed by a plain date
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

/**
 * Adds adaptive streaming URLs to video objects for mobile optimization
 * Attempts to generate HLS + progressive URLs; falls back to original video_url on error
 */
function enrichVideosWithStreamingUrls(videos) {
  if (!videos || videos.length === 0) return videos;
  
  return videos.map((v) => {
    if (!v.video_public_id) {
      // No public ID = external video URL, return as-is
      return v;
    }
    
    try {
      const streamingUrls = generateStreamingUrls(v.video_public_id);
      return {
        ...v,
        streaming_urls: streamingUrls,
        // Keep original as fallback
        video_url: streamingUrls.fallback || v.video_url
      };
    } catch (err) {
      console.warn(`[Video ${v.id}] Failed to generate streaming URLs:`, err.message);
      // Return video unchanged on error
      return v;
    }
  });
}

/**
 * Hydrates query result datasets with user-specific interaction flags
 * @param {Array} videos - Raw catalog matching database rows
 * @param {string|number|null} currentUserId - Session security state identification token
 */
async function enrichVideos(videos, currentUserId) {
  if (!videos || videos.length === 0) return videos || [];

  // Add streaming URLs to all videos
  let enrichedVideos = enrichVideosWithStreamingUrls(videos);

  if (!currentUserId) return enrichedVideos;

  const videoIds = enrichedVideos.map((v) => v.id);
  const userIds = [...new Set(enrichedVideos.map((v) => v.user_id))];

  // Execute relational lookups concurrently across index maps
  const [likedRes, savedRes, followRes] = await Promise.all([
    query("SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)", [currentUserId, videoIds]),
    query("SELECT video_id FROM saves WHERE user_id = $1 AND video_id = ANY($2)", [currentUserId, videoIds]),
    query("SELECT following_id FROM follows WHERE follower_id = $1 AND following_id = ANY($2)", [currentUserId, userIds]),
  ]);

  const likedSet = new Set(likedRes.rows.map((r) => r.video_id));
  const savedSet = new Set(savedRes.rows.map((r) => r.video_id));
  const followSet = new Set(followRes.rows.map((r) => r.following_id));

  return enrichedVideos.map((v) => ({
    ...v,
    is_liked: likedSet.has(v.id),
    is_saved: savedSet.has(v.id),
    is_following: followSet.has(v.user_id),
  }));
}

export const handler = async (event, context) => {
  // 1. Handle CORS Preflight
  const corsResponse = handleCors(event);
  if (corsResponse) return corsResponse;

  // 2. Parse Route and Method
  const path = event.path
    .replace('/.netlify/functions/videos', '')
    .replace('/api/videos', '')
    .replace(/\/$/, '') || '/';
  const method = event.httpMethod;
  const body = parseBody(event);
  const params = event.queryStringParameters || {};

  try {
    // ==========================================
    // CLOUDINARY UPLOAD SIGNATURE
    // ==========================================
    // Provides secure client-side upload tokens to bypass Netlify 6MB limits
    // Supports GET for query-based mobile requests and POST for JSON body requests.
    if ((path === '/upload-signature' || path === '/signature') && (method === 'GET' || method === 'POST')) {
      try {
        const { userId } = requireAuth(event);

        // Guard: Cloudinary must be configured or every upload will fail with an invalid signature
        if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) {
          console.error('[videos/upload-signature] Missing Cloudinary env vars — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in Netlify dashboard');
          return error("Media upload service is not configured. Please contact support.", event, 503);
        }

        const payload = method === 'GET' ? params : body;
        const resourceType = payload.resourceType || payload.resource_type || params.resourceType || params.resource_type || 'video';

        if (!['video', 'image'].includes(resourceType)) {
          return error("resourceType must be 'video' or 'image'", event, 400);
        }

        const folder = payload.folder || params.folder || `yaard/users/${userId}/${resourceType}`;

        // Pass through any extra params the client wants signed (tags, public_id,
        // context, eager, etc). Whatever we sign here, CloudinaryUploader.kt must
        // echo back byte-for-byte in the multipart form, or Cloudinary returns a
        // 401 invalid-signature error. We deliberately do NOT default any
        // transformation/allowed_formats here — see cloudinary.js for why.
        const RESERVED_KEYS = new Set(['resourceType', 'resource_type', 'folder']);
        const additionalParams = {};
        for (const [key, value] of Object.entries(payload)) {
          if (RESERVED_KEYS.has(key)) continue;
          if (value === undefined || value === null || value === '') continue;
          additionalParams[key] = value;
        }

        if (process.env.NODE_ENV === 'development') {
          console.debug('[videos/upload-signature] signature request', {
            userId,
            resourceType,
            folder,
            additionalParams,
          });
        }

        const signaturePayload = generateUploadSignature(folder, resourceType, additionalParams);

        return success(signaturePayload, event);
      } catch (err) {
        return error(err.message || "Failed to generate upload signature", event, err.statusCode || 500);
      }
    }

    // ==========================================
    // PUBLIC ROUTES (No Auth Required)
    // ==========================================
    
    // GET / — Fetch video feed
    // Supports both page-based (?page=1&limit=20) and offset-based (?offset=0&limit=20) pagination.
    // Also supports ?userId= to filter by a specific user's videos.
    if (path === '/' && method === 'GET') {
      const limit = parseInt(params.limit) || 20;
      const page  = parseInt(params.page)  || 1;
      const offset = params.offset !== undefined
        ? parseInt(params.offset)
        : (page - 1) * limit;
      const filterUserId = params.userId || null;

      // Optional: Check if a user is logged in to personalize the feed flags
      let currentUserId = null;
      try {
        const authResult = requireAuth(event);
        currentUserId = authResult.userId;
      } catch (e) {
        // Anonymous user, proceed without personalization flags
      }

      const sqlParams = [limit, offset];
      let whereClause = "WHERE v.status = 'active'";
      if (filterUserId) {
        sqlParams.push(filterUserId);
        whereClause += ` AND v.user_id = $${sqlParams.length}`;
      }

      const sql = `
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               (CASE WHEN a.id IS NOT NULL THEN true ELSE false END) as is_ad_slot,
               a.id as advertisement_id
        FROM videos v 
        LEFT JOIN users u ON v.user_id = u.id 
        LEFT JOIN ads a ON a.video_id = v.id
          AND a.status = 'active'
          AND a.payment_status = 'paid'
          AND (a.ends_at IS NULL OR a.ends_at >= CURRENT_DATE)
          AND a.spent < a.budget
        ${whereClause}
        ORDER BY (CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) DESC,
                 v.created_at DESC
        LIMIT $1 OFFSET $2
      `;
      
      const result = await query(sql, sqlParams);
      const enrichedVideos = await enrichVideos(result.rows, currentUserId);
      
      return success({ videos: enrichedVideos, count: enrichedVideos.length, page, limit }, event);
    }

    // GET /:id — Fetch single video details
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === 'GET') {
      const videoId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];
      
      let currentUserId = null;
      try {
        const authResult = requireAuth(event);
        currentUserId = authResult.userId;
      } catch (e) {}

      const sql = `
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               (CASE WHEN a.id IS NOT NULL THEN true ELSE false END) as is_ad_slot,
               a.id as advertisement_id
        FROM videos v 
        LEFT JOIN users u ON v.user_id = u.id 
        LEFT JOIN ads a ON a.video_id = v.id
        WHERE v.id = $1
      `;
      
      const result = await query(sql, [videoId]);
      if (result.rows.length === 0) return error("Video not found", event, 404);
      
      const enrichedVideos = await enrichVideos(result.rows, currentUserId);
      return success({ video: enrichedVideos[0] }, event);
    }

    // ==========================================
    // PROTECTED ROUTES (Auth Required)
    // ==========================================

    // POST / — Create a new video listing
    if (path === '/' && method === 'POST') {
      const { userId } = requireAuth(event);
      const {
        title, description, video_url, thumbnail_url, duration,
        price, currency, price_mode,
        category_id, video_public_id,
        // Contact info
        contact_phone, contact_whatsapp, contact_email,
        // Location
        location_address, location_city, location_state, location_country,
        location_lat, location_lng,
        location, latitude, longitude,
        // Product details
        condition, brand, model, year, color, size, mileage, bedrooms, bathrooms, area,
        // Ad targeting metadata
        target_locations, target_countries, target_preferences,
        target_age_min, target_age_max, starts_at, ends_at,
        // Extras
        tags, text_overlays, stickers, music_track
      } = body;

      const getField = (snakeKey, camelKey) =>
        body[snakeKey] !== undefined ? body[snakeKey] : body[camelKey];

      const videoUrlFinal = video_url !== undefined ? video_url : getField('video_url', 'videoUrl');
      const thumbnailUrlFinal = thumbnail_url !== undefined ? thumbnail_url : getField('thumbnail_url', 'thumbnailUrl');
      const priceModeFinal = price_mode !== undefined ? price_mode : getField('price_mode', 'priceMode');
      const categoryIdFinal = category_id !== undefined ? category_id : getField('category_id', 'categoryId');
      const videoPublicIdFinal = video_public_id !== undefined ? video_public_id : getField('video_public_id', 'videoPublicId');
      const contactPhoneFinal = contact_phone !== undefined ? contact_phone : getField('contact_phone', 'contactPhone');
      const contactWhatsappFinal = contact_whatsapp !== undefined ? contact_whatsapp : getField('contact_whatsapp', 'contactWhatsapp');
      const contactEmailFinal = contact_email !== undefined ? contact_email : getField('contact_email', 'contactEmail');
      const locationAddressFinal = location_address !== undefined ? location_address : getField('location_address', 'locationAddress');
      const locationCityFinal = location_city !== undefined ? location_city : getField('location_city', 'locationCity');
      const locationStateFinal = location_state !== undefined ? location_state : getField('location_state', 'locationState');
      const locationCountryFinal = location_country !== undefined ? location_country : getField('location_country', 'locationCountry');
      const locationLatFinal = body.location_lat !== undefined ? body.location_lat
        : body.locationLat !== undefined ? body.locationLat
        : body.latitude !== undefined ? body.latitude
        : location_lat !== undefined ? location_lat
        : getField('location_lat', 'locationLat');
      const locationLngFinal = body.location_lng !== undefined ? body.location_lng
        : body.locationLng !== undefined ? body.locationLng
        : body.longitude !== undefined ? body.longitude
        : location_lng !== undefined ? location_lng
        : getField('location_lng', 'locationLng');
      const locationFinal = location !== undefined ? location
        : body.locationValue !== undefined ? body.locationValue
        : body.locationString !== undefined ? body.locationString
        : [locationAddressFinal, locationCityFinal, locationStateFinal, locationCountryFinal]
            .filter((value) => typeof value === 'string' && value.trim() !== '')
            .join(', ') || null;
      const latitudeFinal = latitude !== undefined ? latitude : body.latitude;
      const longitudeFinal = longitude !== undefined ? longitude : body.longitude;
      const targetLocationsFinal = target_locations !== undefined ? target_locations : getField('target_locations', 'targetLocations');
      const targetCountriesFinal = target_countries !== undefined ? target_countries : getField('target_countries', 'targetCountries');
      const targetPreferencesFinal = target_preferences !== undefined ? target_preferences : getField('target_preferences', 'targetPreferences');
      const targetAgeMinFinal = target_age_min !== undefined ? target_age_min : getField('target_age_min', 'targetAgeMin');
      const targetAgeMaxFinal = target_age_max !== undefined ? target_age_max : getField('target_age_max', 'targetAgeMax');
      const startsAtFinal = starts_at !== undefined ? starts_at : getField('starts_at', 'startsAt');
      const endsAtFinal = ends_at !== undefined ? ends_at : getField('ends_at', 'endsAt');
      const textOverlaysFinal = text_overlays !== undefined ? text_overlays : getField('text_overlays', 'textOverlays');
      const musicTrackFinal = music_track !== undefined ? music_track : getField('music_track', 'musicTrack');

      if (!videoUrlFinal || !title) {
        return error("Video URL and Title are required", event, 400);
      }

      // starts_at/ends_at columns are DATE (migration 010) — normalize whatever
      // the client sent (bare date, full timestamp) into "YYYY-MM-DD".
      let startsAtDate, endsAtDate;
      try {
        startsAtDate = toDateOnly(startsAtFinal);
        endsAtDate = toDateOnly(endsAtFinal);
      } catch (e) {
        return error("starts_at and ends_at must be valid dates (YYYY-MM-DD)", event, 400);
      }
      if (startsAtDate && endsAtDate && endsAtDate < startsAtDate) {
        return error("ends_at cannot be before starts_at", event, 400);
      }

      // Treat undefined/null/'' as "no value given" but preserve a literal 0
      // (the old `value || null` pattern silently nulled out price=0, year=0, etc.)
      const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
      const priceVal = num(price);
      const yearVal = num(year);
      const mileageVal = num(mileage);
      const bedroomsVal = num(bedrooms);
      const bathroomsVal = num(bathrooms);
      const areaVal = num(area);
      const targetAgeMinVal = num(targetAgeMinFinal);
      const targetAgeMaxVal = num(targetAgeMaxFinal);

      const requestedPriceMode = typeof priceModeFinal === 'string' ? priceModeFinal.trim() : '';
      const resolvedPriceMode = ALLOWED_PRICE_MODES.has(requestedPriceMode)
        ? requestedPriceMode
        : (priceVal === null ? 'on_request' : 'actual');

      // Build the insert payload defensively against the DB schema so that
      // deployments with unapplied migrations won't crash with "column does not exist".
      const candidateData = {
        user_id: userId,
        title: title,
        description: description || null,
        video_url: videoUrlFinal,
        video_public_id: videoPublicIdFinal || null,
        thumbnail_url: thumbnailUrlFinal || null,
        duration: num(duration) ?? 0,
        price: priceVal,
        currency: currency || 'KES',
        price_mode: resolvedPriceMode,
        category_id: categoryIdFinal || null,
        contact_phone: contactPhoneFinal || null,
        contact_whatsapp: contactWhatsappFinal || null,
        contact_email: contactEmailFinal || null,
        location: locationFinal || null,
        location_address: locationAddressFinal || null,
        location_city: locationCityFinal || null,
        location_state: locationStateFinal || null,
        // NOTE: was defaulting to 'Nigeria' — Yaard targets the Kenyan market (KES, Paystack KE),
        // and migrations 001/002/011 all default location_country to 'Kenya'. Fixed to match.
        location_country: locationCountryFinal || 'Kenya',
        location_lat: num(locationLatFinal),
        location_lng: num(locationLngFinal),
        latitude: num(latitudeFinal ?? locationLatFinal),
        longitude: num(longitudeFinal ?? locationLngFinal),
        condition: condition || null,
        brand: brand || null,
        model: model || null,
        year: yearVal,
        color: color || null,
        size: size || null,
        mileage: mileageVal || null,
        bedrooms: bedroomsVal,
        bathrooms: bathroomsVal,
        area: areaVal || null,
        tags: Array.isArray(tags) ? tags : tags ? [tags] : null,
        target_locations: Array.isArray(targetLocationsFinal) ? targetLocationsFinal : targetLocationsFinal ? [targetLocationsFinal] : null,
        target_countries: Array.isArray(targetCountriesFinal) ? targetCountriesFinal : targetCountriesFinal ? [targetCountriesFinal] : null,
        target_preferences: Array.isArray(targetPreferencesFinal) ? targetPreferencesFinal : targetPreferencesFinal ? [targetPreferencesFinal] : null,
        target_age_min: targetAgeMinVal,
        target_age_max: targetAgeMaxVal,
        starts_at: startsAtDate,
        ends_at: endsAtDate,
        text_overlays: textOverlaysFinal ? JSON.stringify(textOverlaysFinal) : null,
        stickers: stickers ? JSON.stringify(stickers) : null,
        music_track: musicTrackFinal ? JSON.stringify(musicTrackFinal) : null,
        status: 'active'
      };

      // Query the DB for actual `videos` columns present in this database
      const colsRes = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'videos'");
      const presentCols = new Set(colsRes.rows.map((r) => r.column_name));

      const insertCols = [];
      const placeholders = [];
      const values = [];
      let idx = 1;

      for (const [k, v] of Object.entries(candidateData)) {
        if (!presentCols.has(k)) continue;
        insertCols.push(k);
        placeholders.push(`$${idx++}`);
        values.push(v);
      }

      if (!insertCols.includes('user_id') || !insertCols.includes('title') || !insertCols.includes('video_url')) {
        console.error('[videos/create] Required columns missing in DB schema:', insertCols);
        return error('Server configuration error: required video columns missing', event, 500);
      }

      const insertSql = `INSERT INTO videos (${insertCols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`;

      let result;
      try {
        result = await query(insertSql, values);
      } catch (err) {
        console.error('[videos/create] Failed to insert video (dynamic):', err.message, {
          code: err.code || null,
          detail: err.detail || null,
          hint: err.hint || null,
          constraint: err.constraint || null,
          insertCols,
          sampleValues: values.slice(0, 6),
        });
        return error('Failed to create video: ' + (err.message || 'internal error'), event, 500);
      }

      // Increment the user's video count
      await query(
        "UPDATE users SET videos_count = videos_count + 1 WHERE id = $1",
        [userId]
      );

      const createdVideo = result.rows[0];
      const normalizedVideo = {
        ...createdVideo,
        location: createdVideo.location || [
          createdVideo.location_address,
          createdVideo.location_city,
          createdVideo.location_state,
          createdVideo.location_country,
        ].filter((value) => typeof value === 'string' && value.trim() !== '').join(', ') || null,
        latitude: createdVideo.latitude ?? createdVideo.location_lat ?? null,
        longitude: createdVideo.longitude ?? createdVideo.location_lng ?? null,
        location_lat: createdVideo.location_lat ?? createdVideo.latitude ?? null,
        location_lng: createdVideo.location_lng ?? createdVideo.longitude ?? null,
      };

      // Notify followers of the creator that a new video is live
      await query(
        `INSERT INTO notifications (user_id, from_user_id, type, title, body, data)
         SELECT follower_id, $1, 'new_video', $2, $3, $4
         FROM follows
         WHERE following_id = $1`,
        [
          userId,
          `New video from ${createdVideo.user_id === userId ? 'a creator' : 'a user'}`,
          `${createdVideo.title} is now live on Yaard`,
          JSON.stringify({ video_id: createdVideo.id, title: createdVideo.title, user_id: userId })
        ]
      );

      const [videoWithStreaming] = enrichVideosWithStreamingUrls([normalizedVideo]);

      return success({ video: videoWithStreaming }, event);
    }

    // PUT /:id — Update an existing video listing
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === 'PUT') {
      const { userId } = requireAuth(event);
      const videoId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];
      
      // Verify ownership
      const checkSql = "SELECT user_id FROM videos WHERE id = $1";
      const checkRes = await query(checkSql, [videoId]);
      if (checkRes.rows.length === 0) return error("Video not found", event, 404);
      if (checkRes.rows[0].user_id !== userId) return error("Unauthorized to edit this video", event, 403);

      const getUpdateField = (snakeKey, camelKey) =>
        body[snakeKey] !== undefined ? body[snakeKey] : body[camelKey];

      const status = getUpdateField('status', 'status');
      const title = getUpdateField('title', 'title');
      const description = getUpdateField('description', 'description');
      const price = getUpdateField('price', 'price');
      const price_mode = getUpdateField('price_mode', 'priceMode');
      const locationCity = getUpdateField('location_city', 'locationCity');
      const condition = getUpdateField('condition', 'condition');
      const videoUrl = getUpdateField('video_url', 'videoUrl');
      const thumbnailUrl = getUpdateField('thumbnail_url', 'thumbnailUrl');
      const currency = getUpdateField('currency', 'currency');

      const updates = [];
      const sqlParams = [];
      let paramCounter = 1;

      if (status !== undefined) { updates.push(`status = $${paramCounter++}`); sqlParams.push(status); }
      if (title !== undefined) { updates.push(`title = $${paramCounter++}`); sqlParams.push(title); }
      if (description !== undefined) { updates.push(`description = $${paramCounter++}`); sqlParams.push(description); }
      if (videoUrl !== undefined) { updates.push(`video_url = $${paramCounter++}`); sqlParams.push(videoUrl); }
      if (thumbnailUrl !== undefined) { updates.push(`thumbnail_url = $${paramCounter++}`); sqlParams.push(thumbnailUrl); }
      if (price !== undefined) { updates.push(`price = $${paramCounter++}`); sqlParams.push(price); }
      if (price_mode !== undefined) {
        const requestedPriceMode = typeof price_mode === 'string' ? price_mode.trim() : '';
        if (!ALLOWED_PRICE_MODES.has(requestedPriceMode)) {
          return error("Invalid price_mode value", event, 400);
        }
        updates.push(`price_mode = $${paramCounter++}`);
        sqlParams.push(requestedPriceMode);
      } else if (price !== undefined && price == null) {
        updates.push(`price_mode = 'on_request'`);
      }
      if (currency !== undefined) { updates.push(`currency = $${paramCounter++}`); sqlParams.push(currency); }
      if (locationCity !== undefined) { updates.push(`location_city = $${paramCounter++}`); sqlParams.push(locationCity); }
      if (condition !== undefined) { updates.push(`condition = $${paramCounter++}`); sqlParams.push(condition); }

      if (updates.length === 0) return error("No fields to update", event, 400);

      updates.push(`updated_at = NOW()`);
      sqlParams.push(videoId);

      const sql = `UPDATE videos SET ${updates.join(', ')} WHERE id = $${paramCounter} RETURNING *`;
      const result = await query(sql, sqlParams);
      
      return success({ video: result.rows[0] }, event);
    }

    // DELETE /:id — Delete a video listing
    if (path.match(/^\/([a-zA-Z0-9-]+)$/) && method === 'DELETE') {
      const { userId, role } = requireAuth(event);
      const videoId = path.match(/^\/([a-zA-Z0-9-]+)$/)[1];
      
      // Verify ownership or admin status
      const checkSql = "SELECT user_id FROM videos WHERE id = $1";
      const checkRes = await query(checkSql, [videoId]);
      if (checkRes.rows.length === 0) return error("Video not found", event, 404);
      if (checkRes.rows[0].user_id !== userId && role !== 'admin') {
        return error("Unauthorized to delete this video", event, 403);
      }

      await query("DELETE FROM videos WHERE id = $1", [videoId]);
      // Decrement the user's video count
      await query(
        "UPDATE users SET videos_count = GREATEST(0, videos_count - 1) WHERE id = $1",
        [checkRes.rows[0].user_id]
      );
      return success({ message: "Video deleted successfully" }, event);
    }

    // POST /:id/like — Interaction State Mutator (Like)
    if (path.match(/^\/([a-zA-Z0-9-]+)\/like$/) && method === 'POST') {
      const { userId } = requireAuth(event);
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/like$/)[1];
      
      await query("INSERT INTO likes (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, vid]);
      const res = await query(
        "UPDATE videos SET likes_count = likes_count + 1 WHERE id = $1 RETURNING likes_count, user_id",
        [vid]
      );
      // Update the video owner's total_likes counter
      if (res.rows[0]?.user_id) {
        await query("UPDATE users SET total_likes = total_likes + 1 WHERE id = $1", [res.rows[0].user_id]);
      }
      return success({ liked: true, likes_count: res.rows[0]?.likes_count ?? 0 }, event);
    }

    // DELETE /:id/like — Interaction State Mutator (Unlike)
    if (path.match(/^\/([a-zA-Z0-9-]+)\/like$/) && method === 'DELETE') {
      const { userId } = requireAuth(event);
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/like$/)[1];
      
      await query("DELETE FROM likes WHERE user_id = $1 AND video_id = $2", [userId, vid]);
      const res = await query(
        "UPDATE videos SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1 RETURNING likes_count, user_id",
        [vid]
      );
      // Update the video owner's total_likes counter
      if (res.rows[0]?.user_id) {
        await query("UPDATE users SET total_likes = GREATEST(0, total_likes - 1) WHERE id = $1", [res.rows[0].user_id]);
      }
      return success({ liked: false, likes_count: res.rows[0]?.likes_count ?? 0 }, event);
    }

    // POST /:id/save — Bookmark State Mutator
    if (path.match(/^\/([a-zA-Z0-9-]+)\/save$/) && method === "POST") {
      const { userId } = requireAuth(event);
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/save$/)[1];
      
      await query("INSERT INTO saves (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, vid]);
      const res = await query(
        "UPDATE videos SET saves_count = saves_count + 1 WHERE id = $1 RETURNING saves_count",
        [vid]
      );
      return success({ saved: true, saves_count: res.rows[0]?.saves_count ?? 0 }, event);
    }

    // DELETE /:id/save — Bookmark State Mutator Removals Node
    if (path.match(/^\/([a-zA-Z0-9-]+)\/save$/) && method === "DELETE") {
      const { userId } = requireAuth(event);
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/save$/)[1];
      
      await query("DELETE FROM saves WHERE user_id = $1 AND video_id = $2", [userId, vid]);
      const res = await query(
        "UPDATE videos SET saves_count = GREATEST(0, saves_count - 1) WHERE id = $1 RETURNING saves_count",
        [vid]
      );
      return success({ saved: false, saves_count: res.rows[0]?.saves_count ?? 0 }, event);
    }

    // POST /:id/view — Fire-and-forget view counter (no auth required)
    if (path.match(/^\/([a-zA-Z0-9-]+)\/view$/) && method === 'POST') {
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/view$/)[1];
      let currentUserId = null;
      try { currentUserId = requireAuth(event).userId; } catch {}

      // Increment view counter
      await query(
        "UPDATE videos SET views_count = views_count + 1 WHERE id = $1",
        [vid]
      );
      // Log view event (non-fatal)
      try {
        await query(
          "INSERT INTO video_views (video_id, user_id) VALUES ($1, $2)",
          [vid, currentUserId]
        );
        // Update user total_views counter
        await query(
          `UPDATE users SET total_views = total_views + 1
           WHERE id = (SELECT user_id FROM videos WHERE id = $1)`,
          [vid]
        );
      } catch {}

      return success({ tracked: true }, event);
    }

    // POST /:id/share — Share analytics tracker (no auth required)
    if (path.match(/^\/([a-zA-Z0-9-]+)\/share$/) && method === 'POST') {
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/share$/)[1];
      const res = await query(
        "UPDATE videos SET shares_count = shares_count + 1 WHERE id = $1 RETURNING shares_count",
        [vid]
      );
      return success({ shares_count: res.rows[0]?.shares_count ?? 0 }, event);
    }

    // POST /:id/contact — Track contact events (call/whatsapp/email/view_map)
    if (path.match(/^\/([a-zA-Z0-9-]+)\/contact$/) && method === 'POST') {
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/contact$/)[1];
      let currentUserId = null;
      try { currentUserId = requireAuth(event).userId; } catch {}

      const { type } = body;
      const validTypes = ['call', 'whatsapp', 'email', 'view_map'];
      if (!type || !validTypes.includes(type)) {
        return error("type must be one of: call, whatsapp, email, view_map", event, 400);
      }

      // Increment the appropriate counter
      const counterMap = {
        call: 'calls_count',
        whatsapp: 'whatsapp_count',
        email: 'email_count',
        view_map: null
      };
      const col = counterMap[type];
      if (col) {
        await query(`UPDATE videos SET ${col} = ${col} + 1 WHERE id = $1`, [vid]);
      }

      // Log contact event (non-fatal)
      try {
        await query(
          `INSERT INTO contact_events (video_id, user_id, contact_type) VALUES ($1, $2, $3)`,
          [vid, currentUserId, type]
        );
      } catch {}

      return success({ tracked: true }, event);
    }

    // POST /:id/report — Report a video
    if (path.match(/^\/([a-zA-Z0-9-]+)\/report$/) && method === 'POST') {
      const { userId } = requireAuth(event);
      const vid = path.match(/^\/([a-zA-Z0-9-]+)\/report$/)[1];
      const { reason, description } = body;

      if (!reason) {
        return error("reason is required", event, 400);
      }

      const videoRow = await query("SELECT id, user_id, title FROM videos WHERE id = $1", [vid]);
      if (videoRow.rows.length === 0) {
        return error("Video not found", event, 404);
      }

      const existingReport = await query(
        `SELECT 1 FROM reports WHERE reporter_id = $1 AND video_id = $2 AND reason = $3 LIMIT 1`,
        [userId, vid, reason]
      );
      if (existingReport.rows.length > 0) {
        return success({ reported: false, message: "You have already submitted this report." }, event);
      }

      await query(
        `INSERT INTO reports (reporter_id, video_id, reason, description)
         VALUES ($1, $2, $3, $4)`,
        [userId, vid, reason, description || null]
      );

      // Fetch additional info for email alert
      try {
        const userRes = await query("SELECT username FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length > 0) {
          await sendReportToAdmin({
            videoId: vid,
            videoTitle: videoRow.rows[0].title,
            reporterUsername: userRes.rows[0].username,
            reason,
            description
          });
        }
      } catch (err) {
        console.error("Failed to send report email alert:", err);
      }

      // Check report count threshold
      try {
        const countRes = await query(
          `SELECT COUNT(*)::integer as count FROM reports WHERE video_id = $1`,
          [vid]
        );
        const reportCount = countRes.rows[0].count;

        if (reportCount >= 1000) {
          const ownerId = videoRow.rows[0].user_id;
          const adTitle = videoRow.rows[0].title;

          // Prevent spamming warning notifications if already sent
          const existsWarn = await query(
            `SELECT id FROM notifications 
               WHERE user_id = $1 AND type = 'ad' AND title = 'Ad/Post Warning Alert' 
                 AND (data->>'video_id' = $2 OR (data->>'video_id')::text = $2)`,
            [ownerId, vid]
          );

          if (existsWarn.rows.length === 0) {
            await query(
              `INSERT INTO notifications (user_id, type, title, body, data)
               VALUES ($1, 'ad', 'Ad/Post Warning Alert', $2, $3)`,
              [
                ownerId,
                `Your listing "${adTitle}" has been flagged by multiple users (1,000+ reports). Please review it to ensure compliance.`,
                JSON.stringify({ video_id: vid, reason: "warning_threshold_reached", reports_count: reportCount })
              ]
            );
          }
        }
      } catch (err) {
        console.error("Report threshold logic warning failure:", err);
      }

      return success({ reported: true }, event);
    }

    return error("Requested route not found in videos service", event, 404);

  } catch (err) {
    console.error("[Videos API Error]:", err);
    return error(err.message || "Internal Server Error", event, err.statusCode || 500);
  }
};