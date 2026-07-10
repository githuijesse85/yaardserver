import { sign, verify } from "jsonwebtoken";
import { hash, compare } from "bcryptjs";
import { query } from "../../shared/db.js";
import { handleCors, success, error, parseBody, requireAuth } from "../../shared/middleware.js";
import { cloudinary, generateUploadSignature } from "../../shared/cloudinary.js";
import { sendAdWarningEmail } from "../../shared/email.js";

// SECURITY: Use environment variable for admin password
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '').trim();
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_JWT_TTL = process.env.ADMIN_JWT_TTL || '12h';
const ALLOWED_PRICE_MODES = new Set(['actual', 'from', 'reserved', 'on_request']);

// Validate admin credentials at startup
if (!ADMIN_PASSWORD) {
  console.error("[Admin Config Error]: ADMIN_PASSWORD environment variable is required. Set it in Netlify Site Settings → Build & Deploy → Environment");
}

async function deleteAdAndAssociations(adId) {
  const adIds = [adId];
  await query("UPDATE payments SET ad_id = NULL WHERE ad_id = ANY($1)", [adIds]);
  await query(
    `DELETE FROM notifications
     WHERE (data->>'ad_id') = ANY($1)
       OR ((data->>'ad_id')::text) = ANY($1)`,
    [adIds]
  );
  await query("DELETE FROM ads WHERE id = $1", [adId]);
}

async function deleteVideoAndAssociations(videoId) {
  const adRows = await query("SELECT id FROM ads WHERE video_id = $1", [videoId]);
  const adIds = adRows.rows.map((row) => row.id).filter(Boolean);

  if (adIds.length > 0) {
    await query("UPDATE payments SET ad_id = NULL WHERE ad_id = ANY($1)", [adIds]);
    await query(
      `DELETE FROM notifications
       WHERE (data->>'ad_id') = ANY($1)
         OR ((data->>'ad_id')::text) = ANY($1)`,
      [adIds]
    );
    await query("DELETE FROM ads WHERE id = ANY($1)", [adIds]);
  }

  await query("UPDATE reports SET status = 'resolved_deleted', video_id = NULL WHERE video_id = $1", [videoId]);
  await query(
    `DELETE FROM notifications
     WHERE (data->>'video_id' = $1 OR (data->>'video_id')::text = $1)`,
    [videoId]
  );
  await query("DELETE FROM video_views WHERE video_id = $1", [videoId]);
  await query("DELETE FROM videos WHERE id = $1", [videoId]);
}

async function deleteUserAndAssociations(userId) {
  // Clean up ads created by the user, preserving transactional integrity.
  const userAds = await query("SELECT id FROM ads WHERE user_id = $1", [userId]);
  const userAdIds = userAds.rows.map((row) => row.id).filter(Boolean);
  if (userAdIds.length > 0) {
    await query("UPDATE payments SET ad_id = NULL WHERE ad_id = ANY($1)", [userAdIds]);
    await query(
      `DELETE FROM notifications
       WHERE (data->>'ad_id') = ANY($1)
         OR ((data->>'ad_id')::text) = ANY($1)`,
      [userAdIds]
    );
    await query("DELETE FROM ads WHERE id = ANY($1)", [userAdIds]);
  }

  // Clean up all videos created by the user and any ads attached to them.
  const userVideos = await query("SELECT id FROM videos WHERE user_id = $1", [userId]);
  for (const row of userVideos.rows) {
    if (row.id) {
      await deleteVideoAndAssociations(row.id);
    }
  }

  await query("DELETE FROM payments WHERE user_id = $1", [userId]);
  await query("DELETE FROM reports WHERE reporter_id = $1 OR user_id = $1", [userId]);
  await query(
    `DELETE FROM notifications
     WHERE user_id = $1 OR from_user_id = $1`,
    [userId]
  );
  await query("DELETE FROM video_views WHERE user_id = $1", [userId]);
  await query("DELETE FROM users WHERE id = $1", [userId]);
}

export const handler = async (event, context) => {
  // 1. Handle CORS Preflight
  const corsResponse = handleCors(event);
  if (corsResponse) return corsResponse;

  // 2. Parse Route and Method
  const path = event.path
    .replace('/.netlify/functions/admin', '')
    .replace('/api/admin', '')
    .replace(/\/$/, '') || '/';
  const method = event.httpMethod;
  const body = parseBody(event);
  const params = event.queryStringParameters || {};

  try {
    // ==========================================
    // PUBLIC ROUTE: AUTHENTICATION
    // ==========================================
    // Diagnostic endpoint: returns configuration status
    if (path === '/diag' && method === 'GET') {
      return success({
        ADMIN_PASSWORD_SET: !!ADMIN_PASSWORD,
        JWT_SECRET_SET: !!JWT_SECRET,
        timestamp: new Date().toISOString(),
        message: !ADMIN_PASSWORD ? "CRITICAL: ADMIN_PASSWORD not configured in environment" : "All systems operational"
      }, event);
    }

    if (path === '/login' && method === 'POST') {
      const rawPassword = body.password;
      const password = typeof rawPassword === 'string' ? rawPassword.trim() : '';
      if (!password) {
        return error("Password is required", event, 400);
      }
      if (!ADMIN_PASSWORD) {
        return error("Admin system not configured. Set ADMIN_PASSWORD environment variable in Netlify", event, 503);
      }
      if (password !== ADMIN_PASSWORD) {
        return error("Invalid admin password", event, 401);
      }
      // Enforce JWT usage for admin sessions; require JWT_SECRET
      if (!JWT_SECRET) {
        return error("Server misconfigured: JWT_SECRET must be set for admin sessions", event, 503);
      }
      let token;
      try {
        token = sign({ role: 'admin', type: 'admin_session' }, JWT_SECRET, { expiresIn: ADMIN_JWT_TTL });
      } catch (e) {
        console.error('[Admin JWT] Failed to sign token', e.message);
        return error('Failed to create admin session token', event, 500);
      }
      return success({ token }, event);
    }

    // ==========================================
    // PROTECTED ROUTES - Authentication Required
    // ==========================================
    // All routes except /login and /diag require a valid admin JWT token.
    if (path !== '/login' && path !== '/diag') {
      const authHeader = (event.headers || {}).authorization || (event.headers || {}).Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return error('Admin authentication required. Please log in.', event, 401);
      }
      const adminToken = authHeader.split(' ')[1];
      if (!JWT_SECRET) {
        return error('Server misconfigured: JWT_SECRET is not set.', event, 503);
      }
      try {
        const decoded = verify(adminToken, JWT_SECRET);
        if (!decoded || decoded.role !== 'admin' || decoded.type !== 'admin_session') {
          return error('Invalid or expired admin session. Please log in again.', event, 401);
        }
      } catch (jwtErr) {
        return error('Admin session expired or invalid. Please log in again.', event, 401);
      }
    }

    if (path === '/verify' && method === 'GET') {
      return success({ valid: true }, event);
    }

    const segments = path.split('/').filter(Boolean);
    const resource = segments[0];
    const resourceId = segments[1];

    // --- DASHBOARD TELEMETRY ---
    if (resource === 'dashboard' && method === 'GET') {
      const parseCount = (value) => Number(value) || 0;

      const [users, newUsers, videos, viewsRes, ads, adSpendRes, revenueRes, successfulPayments, pendingReports, topVideos, categories] = await Promise.all([
        query("SELECT COUNT(*)::bigint AS count FROM users"),
        query("SELECT COUNT(*)::bigint AS count FROM users WHERE created_at >= NOW() - INTERVAL '24 hours'"),
        query("SELECT COUNT(*)::bigint AS count FROM videos WHERE status = 'active'"),
        query("SELECT COALESCE(SUM(views_count), 0)::bigint AS total_views FROM videos WHERE status = 'active'"),
        query("SELECT COUNT(*)::bigint AS count FROM ads WHERE status IN ('active', 'pending')"),
        query("SELECT COALESCE(SUM(budget), 0)::numeric(18,2) AS total_ad_spend FROM ads WHERE status = 'active'"),
        query("SELECT COALESCE(SUM(amount), 0)::numeric(18,2) AS total_revenue FROM payments WHERE status = 'success'"),
        query("SELECT COUNT(*)::bigint AS count FROM payments WHERE status = 'success'"),
        query("SELECT COUNT(*)::bigint AS count FROM reports WHERE status = 'pending'"),
        query(`SELECT v.id, v.title, v.views_count, u.username FROM videos v 
               LEFT JOIN users u ON v.user_id = u.id 
               WHERE v.status = 'active' ORDER BY v.views_count DESC LIMIT 5`),
        query("SELECT COUNT(*)::bigint AS count FROM categories")
      ]);

      return success({
        metrics: {
          total_users: parseCount(users.rows[0].count),
          new_users_24h: parseCount(newUsers.rows[0].count),
          total_videos: parseCount(videos.rows[0].count),
          total_views: parseCount(viewsRes.rows[0].total_views),
          total_ads: parseCount(ads.rows[0].count),
          total_ad_spend: Number(adSpendRes.rows[0].total_ad_spend) || 0,
          total_revenue: Number(revenueRes.rows[0].total_revenue) || 0,
          successful_payments: parseCount(successfulPayments.rows[0].count),
          pending_reports: parseCount(pendingReports.rows[0].count),
          total_categories: parseCount(categories.rows[0].count)
        },
        top_videos: topVideos.rows,
        generated_at: new Date().toISOString()
      }, event);
    }

    // --- ANALYTICS ENDPOINT ---
    if (resource === 'analytics' && method === 'GET') {
      const timeframe = params.timeframe || '7d';
      const validTimeframes = new Set(['1d', '7d', '30d', '90d', '180d', '365d']);
      const safeTimeframe = validTimeframes.has(timeframe) ? timeframe : '7d';
      const videoId = params.videoId;

      if (videoId) {
        // Single video analytics
        const result = await query(
          `SELECT date, views_count, likes_count, comments_count, shares_count, 
                  calls_count, whatsapp_count, email_count
           FROM video_analytics
           WHERE video_id = $1 AND date >= NOW()::date - INTERVAL '${timeframe}'
           ORDER BY date DESC`,
          [videoId]
        );
        return success({ analytics: result.rows }, event);
      } else {
        // Platform-wide analytics
        const [dailyStats, categoryStats, locationStats] = await Promise.all([
          query(`
            SELECT DATE(created_at) as date, 
                   COUNT(*) as new_users,
                   (SELECT COALESCE(SUM(views_count), 0) FROM videos WHERE created_at::date = DATE(created_at)) as views
            FROM users 
            WHERE created_at >= NOW() - INTERVAL '${safeTimeframe}'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
          `),
          query(`
            SELECT c.name, COUNT(v.id) as videos, COALESCE(SUM(v.views_count), 0) as views
            FROM categories c
            LEFT JOIN videos v ON v.category_id = c.id
            GROUP BY c.id, c.name
            ORDER BY views DESC
          `),
          query(`
            SELECT location_city, COUNT(*) as listings, COALESCE(SUM(views_count), 0) as views
            FROM videos
            WHERE location_city IS NOT NULL AND status = 'active'
            GROUP BY location_city
            ORDER BY views DESC
            LIMIT 20
          `)
        ]);

        return success({
          period: timeframe,
          daily_stats: dailyStats.rows,
          category_stats: categoryStats.rows,
          location_stats: locationStats.rows,
          generated_at: new Date().toISOString()
        }, event);
      }
    }

    // --- USERS MANAGEMENT ---
    if (resource === 'users') {
      if (method === 'GET' && resourceId) {
        const result = await query(`SELECT id, username, email, display_name, phone, whatsapp, website, is_verified, is_business, created_at, updated_at
                                    FROM users WHERE id = $1`, [resourceId]);
        if (!result.rows.length) return error("User record not found", event, 404);
        return success({ user: result.rows[0] }, event);
      }

      if (method === 'GET') {
        const searchTerm = params.q || params.search ? `%${params.q || params.search}%` : null;
        const sql = searchTerm
          ? `SELECT id, username, email, display_name, phone, whatsapp, website, is_verified, is_business, created_at
             FROM users WHERE username ILIKE $1 OR email ILIKE $1 OR display_name ILIKE $1
             ORDER BY created_at DESC LIMIT 50`
          : `SELECT id, username, email, display_name, phone, whatsapp, website, is_verified, is_business, created_at
             FROM users ORDER BY created_at DESC LIMIT 50`;
        const sqlParams = searchTerm ? [searchTerm] : [];
        const result = await query(sql, sqlParams);
        return success({ users: result.rows }, event);
      }

      if (method === 'POST') {
        const { username, email, password, display_name, phone, whatsapp, website, is_verified, is_business } = body;
        if (!username || !email || !password) {
          return error("username, email, and password are required to create a user.", event, 400);
        }

        const passwordHash = await hash(password, 12);
        const sql = `INSERT INTO users (username, email, password_hash, display_name, phone, whatsapp, website, is_verified, is_business)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`;
        const result = await query(sql, [username, email, passwordHash, display_name, phone, whatsapp, website, is_verified, is_business]);
        
        return success({ user: result.rows[0] }, event);
      }

      if (method === 'PUT' && resourceId) {
        const { username, email, display_name, phone, whatsapp, website, is_verified, is_business } = body;
        const sql = `UPDATE users SET username = $1, email = $2, display_name = $3, phone = $4, whatsapp = $5, website = $6, is_verified = $7, is_business = $8, updated_at = NOW()
                     WHERE id = $9 RETURNING *`;
        const result = await query(sql, [username, email, display_name, phone, whatsapp, website, is_verified, is_business, resourceId]);
        
        return success({ user: result.rows[0] }, event);
      }

      if (method === 'DELETE' && resourceId) {
        await deleteUserAndAssociations(resourceId);
        return success({ message: "User deleted with all associated content" }, event);
      }
    }

    // --- VIDEOS MANAGEMENT ---
    if (resource === 'videos') {
      if (method === 'GET' && resourceId) {
        const result = await query(`SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id WHERE v.id = $1`, [resourceId]);
        if (!result.rows.length) return error("Video record not found", event, 404);
        return success({ video: result.rows[0] }, event);
      }

      if (method === 'GET') {
        const searchTerm = params.q || params.search ? `%${params.q || params.search}%` : null;
        const sql = searchTerm
          ? `SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id
             WHERE v.title ILIKE $1 OR u.username ILIKE $1 ORDER BY v.created_at DESC LIMIT 50`
          : `SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id
             ORDER BY v.created_at DESC LIMIT 50`;
        const sqlParams = searchTerm ? [searchTerm] : [];
        const result = await query(sql, sqlParams);
        return success({ videos: result.rows }, event);
      }

      if (method === 'POST') {
        const {
          user_id, title, description, video_url, thumbnail_url, price, currency, price_mode, location_city,
          condition, brand, model, status, category_id, video_public_id
        } = body;
        const requestedPriceMode = typeof price_mode === 'string' ? price_mode.trim() : '';
        const resolvedPriceMode = ALLOWED_PRICE_MODES.has(requestedPriceMode)
          ? requestedPriceMode
          : (price == null ? 'on_request' : 'actual');
        const sql = `INSERT INTO videos (user_id, title, description, video_url, thumbnail_url, price, currency, price_mode, location_city,
                     condition, brand, model, status, category_id, video_public_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`;
        const result = await query(sql, [user_id, title, description, video_url, thumbnail_url, price, currency || 'KES', resolvedPriceMode, location_city,
          condition, brand, model, status || 'active', category_id || null, video_public_id || null]);
        
        return success({ video: result.rows[0] }, event);
      }

      if (method === 'PUT' && resourceId) {
        const { status, title, video_url, thumbnail_url, price, price_mode, location_city, description, currency, condition, brand, model } = body;

        const updates = [];
        const sqlParams = [];
        let paramCounter = 1;

        if (status !== undefined) { updates.push(`status = $${paramCounter++}`); sqlParams.push(status); }
        if (title !== undefined) { updates.push(`title = $${paramCounter++}`); sqlParams.push(title); }
        if (description !== undefined) { updates.push(`description = $${paramCounter++}`); sqlParams.push(description); }
        if (video_url !== undefined) { updates.push(`video_url = $${paramCounter++}`); sqlParams.push(video_url); }
        if (thumbnail_url !== undefined) { updates.push(`thumbnail_url = $${paramCounter++}`); sqlParams.push(thumbnail_url); }
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
        if (location_city !== undefined) { updates.push(`location_city = $${paramCounter++}`); sqlParams.push(location_city); }
        if (condition !== undefined) { updates.push(`condition = $${paramCounter++}`); sqlParams.push(condition); }
        if (brand !== undefined) { updates.push(`brand = $${paramCounter++}`); sqlParams.push(brand); }
        if (model !== undefined) { updates.push(`model = $${paramCounter++}`); sqlParams.push(model); }

        if (updates.length === 0) return error("No fields to update", event);

        updates.push(`updated_at = NOW()`);
        sqlParams.push(resourceId);

        const sql = `UPDATE videos SET ${updates.join(', ')} WHERE id = $${paramCounter} RETURNING *`;
        const result = await query(sql, sqlParams);
        
        return success({ video: result.rows[0] }, event);
      }

      if (method === 'DELETE' && resourceId) {
        await deleteVideoAndAssociations(resourceId);
        return success({ message: "Video and all related content deleted" }, event);
      }
    }

    // --- ADS MANAGEMENT ---
    if (resource === 'ads') {
      if (method === 'GET' && resourceId) {
        const sql = `SELECT a.*, u.username, u.id as user_id, v.title as video_title, v.thumbnail_url
                     FROM ads a
                     LEFT JOIN users u ON a.user_id = u.id
                     LEFT JOIN videos v ON a.video_id = v.id
                     WHERE a.id = $1`;
        const result = await query(sql, [resourceId]);
        if (result.rows.length === 0) return error("Ad record not found", event, 404);
        return success({ ad: result.rows[0] }, event);
      }

      if (method === 'GET') {
        const searchTerm = params.q || params.search ? `%${params.q || params.search}%` : null;
        const statusFilter = params.status ? params.status.trim().toLowerCase() : null;
        let sql = `SELECT a.id, a.title, a.budget, a.status, a.video_id, a.impressions, a.clicks, a.payment_status,
                          a.spent, u.username, u.id as user_id, v.title AS video_title
                   FROM ads a
                   LEFT JOIN users u ON a.user_id = u.id
                   LEFT JOIN videos v ON a.video_id = v.id`;
        const sqlParams = [];
        const whereClauses = [];

        if (searchTerm) {
          whereClauses.push(`(a.title ILIKE $${sqlParams.length + 1} OR u.username ILIKE $${sqlParams.length + 1} OR v.title ILIKE $${sqlParams.length + 1})`);
          sqlParams.push(searchTerm);
        }
        if (statusFilter) {
          whereClauses.push(`LOWER(a.status) = $${sqlParams.length + 1}`);
          sqlParams.push(statusFilter);
        }

        if (whereClauses.length) {
          sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        sql += ` ORDER BY a.created_at DESC LIMIT 100`;
        const result = await query(sql, sqlParams);
        return success({ ads: result.rows }, event);
      }

      if (method === 'POST') {
        const { user_id, video_id, title, description, target_url, budget, status, currency } = body;
        const sql = `INSERT INTO ads (user_id, video_id, title, description, target_url, budget, currency, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`;
        const result = await query(sql, [user_id, video_id || null, title, description || null, target_url || null, budget, currency || 'KES', status || 'pending']);
        
        return success({ ad: result.rows[0] }, event);
      }

      if (method === 'PUT' && resourceId) {
        const { status, title, budget, video_id } = body;
        const sql = `UPDATE ads SET status = COALESCE($1, status), title = COALESCE($2, title), budget = COALESCE($3, budget),
                     video_id = COALESCE($4, video_id), updated_at = NOW() WHERE id = $5 RETURNING *`;
        const result = await query(sql, [status, title, budget, video_id, resourceId]);
        
        return success({ ad: result.rows[0] }, event);
      }

      if (method === 'DELETE' && resourceId) {
        await deleteAdAndAssociations(resourceId);
        return success({ message: "Ad and all related content deleted" }, event);
      }
    }

    // --- PAYMENTS ---
    if (resource === 'payments' && method === 'GET') {
      const searchTerm = params.q || params.search ? `%${params.q || params.search}%` : null;
      let sql = `SELECT p.*, u.username, u.email FROM payments p LEFT JOIN users u ON p.user_id = u.id`;
      const sqlParams = [];
      if (searchTerm) {
        sql += ` WHERE p.paystack_reference ILIKE $1 OR u.username ILIKE $1 OR u.email ILIKE $1`;
        sqlParams.push(searchTerm);
      }
      sql += ` ORDER BY p.created_at DESC LIMIT 100`;
      const result = await query(sql, sqlParams);
      return success({ payments: result.rows }, event);
    }

    // --- CASHBACK ISSUANCE (Admin action) ---
    if (resource === 'cashback' && method === 'POST') {
      const { user_id, amount, reason } = body;
      if (!user_id || !amount) return error('user_id and amount are required', event, 400);

      const sql = `INSERT INTO payments (user_id, amount, currency, paystack_reference, status, payment_type, metadata, paid_at, created_at)
                   VALUES ($1, $2, 'KES', $3, 'success', 'cashback', $4, NOW(), NOW()) RETURNING *`;
      const ref = `cashback_${Date.now()}`;
      const metadata = JSON.stringify({ reason: reason || 'manual_cashback', issued_by: 'admin' });
      const result = await query(sql, [user_id, amount, ref, metadata]);

      return success({ cashback: result.rows[0] }, event);
    }

    // --- REPORTS ---
    if (resource === 'reports') {
      if (method === 'POST' && resourceId && segments[2] === 'action') {
        const { action, warningText } = body;
        if (!action) return error("Action type is required", event, 400);

        // Fetch report and associated owner/video
        const reportSql = `
          SELECT r.*, v.title AS video_title, v.user_id AS owner_id, owner.username AS owner_username, owner.email AS owner_email
          FROM reports r
          LEFT JOIN videos v ON r.video_id = v.id
          LEFT JOIN users owner ON v.user_id = owner.id
          WHERE r.id = $1`;
        const reportRes = await query(reportSql, [resourceId]);
        if (reportRes.rows.length === 0) return error("Report record not found", event, 404);
        
        const report = reportRes.rows[0];
        const { video_id, owner_id, owner_username, owner_email, video_title, reason } = report;

        if (action === 'delete') {
          if (!video_id) return error("No associated video content for this report.", event, 400);

          // Preserve report history by marking all video reports resolved and detaching the video.
          await query("UPDATE reports SET status = 'resolved_deleted', video_id = NULL WHERE video_id = $1", [video_id]);
          await query("DELETE FROM notifications WHERE (data->>'video_id' = $1 OR (data->>'video_id')::text = $1)", [video_id]);
          await query("DELETE FROM videos WHERE id = $1", [video_id]);

          // Also delete any associated ad campaigns completely.
          await query("DELETE FROM ads WHERE video_id = $1", [video_id]);

          return success({ message: "Content and associated ads deleted completely", resolved: true }, event);
        }

        if (action === 'warn') {
          if (!owner_id) return error("No content owner associated with this report.", event, 400);
          
          const text = warningText || `Your listing "${video_title || 'Unnamed'}" has been flagged by users. Please check our guidelines.`;
          
          await query(
            `INSERT INTO notifications (user_id, type, title, body, data)
             VALUES ($1, 'ad', 'Content Moderation Warning', $2, $3)`,
            [owner_id, text, JSON.stringify({ video_id, reason: 'moderator_warning' })]
          );

          await query("UPDATE reports SET status = 'resolved_warned' WHERE id = $1", [resourceId]);
          return success({ message: "In-app warning sent to owner", resolved: true }, event);
        }

        if (action === 'email') {
          if (!owner_email) return error("No owner email address available.", event, 400);
          
          await sendAdWarningEmail(owner_email, owner_username || 'User', reason, video_title || 'Unnamed Ad');
          await query("UPDATE reports SET status = 'resolved_emailed' WHERE id = $1", [resourceId]);
          return success({ message: "Warning email successfully sent to owner", resolved: true }, event);
        }

        return error("Invalid action type. Use: delete, warn, or email", event, 400);
      }

      if (method === 'GET' && resourceId) {
        const sql = `SELECT r.*, u.username AS reporter_username, v.title AS video_title,
                            owner.id AS owner_id, owner.username AS owner_username, owner.email AS owner_email
                     FROM reports r
                     LEFT JOIN users u ON r.reporter_id = u.id
                     LEFT JOIN videos v ON r.video_id = v.id
                     LEFT JOIN users owner ON v.user_id = owner.id
                     WHERE r.id = $1`;
        const result = await query(sql, [resourceId]);
        if (result.rows.length === 0) return error("Report record not found", event, 404);
        return success({ report: result.rows[0] }, event);
      }

      if (method === 'DELETE' && resourceId) {
        await query("DELETE FROM reports WHERE id = $1", [resourceId]);
        return success({ message: 'Report deleted' }, event);
      }

      if (method === 'GET') {
        const statusFilter = params.status ? params.status.trim().toLowerCase() : null;
        const searchTerm = params.q || params.search ? `%${params.q || params.search}%` : null;
        let sql = `SELECT r.*, u.username AS reporter_username, v.title AS video_title,
                            owner.id AS owner_id, owner.username AS owner_username, owner.email AS owner_email
                     FROM reports r
                     LEFT JOIN users u ON r.reporter_id = u.id
                     LEFT JOIN videos v ON r.video_id = v.id
                     LEFT JOIN users owner ON v.user_id = owner.id`;
        const sqlParams = [];
        const whereClauses = [];

        if (statusFilter) {
          whereClauses.push(`LOWER(r.status) = $${sqlParams.length + 1}`);
          sqlParams.push(statusFilter);
        }
        if (searchTerm) {
          whereClauses.push(`(r.reason ILIKE $${sqlParams.length + 1} OR r.description ILIKE $${sqlParams.length + 1} OR u.username ILIKE $${sqlParams.length + 1} OR v.title ILIKE $${sqlParams.le[...]
          sqlParams.push(searchTerm);
        }
        if (whereClauses.length) {
          sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        sql += ` ORDER BY r.created_at DESC LIMIT 200`;
        const result = await query(sql, sqlParams);
        return success({ reports: result.rows }, event);
      }

      if (method === 'PUT' && resourceId) {
        const { status } = body;
        if (!status) return error("Status update value is required", event, 400);
        const sql = `UPDATE reports SET status = $1 WHERE id = $2 RETURNING *`;
        const result = await query(sql, [status, resourceId]);
        return success({ report: result.rows[0] }, event);
      }
    }

    // --- CLOUDINARY UPLOAD SIGNATURE ---
    if (resource === 'cloudinary-sign' && method === 'GET') {
      try {
        const params = event.queryStringParameters || {};
        const folder = params.folder || 'yaard/videos';
        const resourceType = params.resourceType || params.resource_type || 'video';
        const additionalParams = {};

        // Use the new unified signature generator with resource_type
        const signaturePayload = generateUploadSignature(folder, resourceType, additionalParams);
        
        return success(signaturePayload, event);
      } catch (err) {
        return error(`Failed to generate signature: ${err.message}`, event, 500);
      }
    }

    // --- CLOUDINARY UPLOAD TEST (For your Diagnostic Dashboard) ---
    if (resource === 'cloudinary-test' && method === 'GET') {
      try {
        // This simulates a tiny 1px server-side upload to verify write access
        const base64Image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const uploadResult = await cloudinary.uploader.upload(base64Image, {
          folder: 'yaard/system_tests'
        });
        return success({ status: "Upload successful", public_id: uploadResult.public_id }, event);
      } catch (err) {
        return error(`Upload test failed: ${err.message}`, event, 500);
      }
    }

    // --- SYSTEM ENDPOINTS (Enhanced Diagnostics) ---
    if (resource === 'test-connections' && method === 'GET') {
      const diagnostics = { timestamp: new Date().toISOString() };

      // 1. Supabase/PostgreSQL Connection Test
      try {
        const dbStatus = await query("SELECT 1 AS ok");
        diagnostics.database = dbStatus.rows[0].ok === 1 ? "Connected & Healthy" : "Failing";
      } catch (e) { 
        diagnostics.database = `Error: ${e.message}`; 
      }

      // 2. Cloudinary API Ping
      try {
        const cldPing = await cloudinary.api.ping();
        diagnostics.cloudinary = cldPing.status === "ok" ? "Connected & Healthy" : "Failing";
      } catch (e) { 
        diagnostics.cloudinary = `Error: ${e.message}`; 
      }

      // 3. Paystack Authenticated Check
      try {
        if (!process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is undefined in .env");
        const psRes = await fetch("https://api.paystack.co/integration/payment_session_timeout", {
          method: "GET",
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });
        diagnostics.paystack = psRes.status === 200 ? "Connected & Healthy" : `Failing with status ${psRes.status}`;
      } catch (e) { 
        diagnostics.paystack = `Error: ${e.message}`; 
      }

      // 4. Email/SMTP Config Check
      diagnostics.email = (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.SMTP_HOST) 
        ? "Configured & Ready" 
        : "Missing SMTP Credentials in .env";

      return success(diagnostics, event);
    }

    if (resource === 'seed' && method === 'POST') {
      // SECURITY: Require explicit confirmation before destructive operations
      if (!body.wipe || body.wipe !== true) {
        return error("Destructive wipe requires explicit wipe confirmation flag set to true", event, 400);
      }

      try {
        // Safe truncation: only truncate tables that exist
        const tablesToWipe = ['videos', 'users', 'ads', 'payments', 'comments', 'likes', 'follows', 'saves'];
        
        for (const table of tablesToWipe) {
          try {
            await query(`TRUNCATE TABLE ${table} CASCADE`);
          } catch (e) {
            // Skip if table doesn't exist
            console.warn(`[Seed] Table ${table} not found or truncate failed:`, e.message);
          }
        }

        // Re-seed categories
        await query(`
          INSERT INTO categories (name, slug, sort_order) VALUES
          ('Properties', 'properties', 1), 
          ('Automotive', 'automotive', 2),
          ('Furniture', 'furniture', 3),
          ('Electronics', 'electronics', 4),
          ('Fashion', 'fashion', 5),
          ('Food & Drinks', 'food-drinks', 6),
          ('Services', 'services', 7),
          ('Other', 'other', 8)
          ON CONFLICT (slug) DO NOTHING
        `);

        return success({ 
          message: "Database seeding completed successfully", 
          summary: { 
            tables_wiped: tablesToWipe.length,
            categories_reseeded: true
          } 
        }, event);
      } catch (err) {
        return error(`Seed operation failed: ${err.message}`, event, 500);
      }
    }

    return error("Endpoint not found", event, 404);

  } catch (err) {
    console.error("[Admin API Error]:", err);
    return error(err.message || "Internal Server Error", event, err.statusCode || 500);
  }
};
