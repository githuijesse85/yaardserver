import { hash, compare } from "bcryptjs";
import { sign, verify } from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query } from "../../shared/db";
import { handleCors, success, error, parseBody } from "../../shared/middleware";
import { sendVerificationEmail, sendPasswordResetEmail } from "../../shared/email";

/**
 * Generates decoupled structural Access and Refresh JWT tokens
 * @param {string|number} userId - The unique user identification primary key
 */
function generateTokens(userId) {
  const accessExpiry = process.env.JWT_EXPIRES_IN || "7d";
  const refreshExpiry = process.env.REFRESH_TOKEN_EXPIRES_IN || "30d";

  const accessToken = sign(
    { userId, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: accessExpiry }
  );
  const refreshToken = sign(
    { userId, type: "refresh" },
    process.env.JWT_SECRET,
    { expiresIn: refreshExpiry }
  );
  return { accessToken, refreshToken };
}

export async function handler(event, context) {
  // CRITICAL FIX: Directs Netlify to immediately return execution once the HTTP payload handles,
  // preventing active idle PostgreSQL client pool connections from hanging the handler thread.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  const path = event.path.replace("/.netlify/functions/auth", "").replace("/api/auth", "");
  const method = event.httpMethod;

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // POST /register — Multi-Tenant User Onboarding Pipeline
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/register" && method === "POST") {
      const { email, username, password, displayName, phone } = parseBody(event);

      if (!email || !username || !password) {
        return error("Email, username, and password fields are strictly required.", event, 400);
      }
      if (password.length < 8) {
        return error("Password length must contain at least 8 alphanumeric characters.", event, 400);
      }
      
      const cleanEmail = String(email).trim().toLowerCase();
      const cleanUsername = String(username).trim().toLowerCase();

      if (cleanUsername.length < 3 || !/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
        return error("Username must be 3+ characters (letters, numbers, underscores only).", event, 400);
      }

      // Check for user collisions securely
      const existing = await query(
        "SELECT id FROM users WHERE email = $1 OR username = $2",
        [cleanEmail, cleanUsername]
      );
      if (existing.rows.length > 0) {
        return error("Email address or username identifier is already registered.", event, 409);
      }

      // Hash user passphrase with secure computational work factors
      const passwordHash = await hash(password, 12);

      // Generate verification identity tokens (Expires exactly in 24 Hours)
      const verificationToken = uuidv4();
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const result = await query(
        `INSERT INTO users (
           email, username, password_hash, display_name, phone,
           email_verification_token, email_verification_expires
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, username, display_name, bio, avatar_url, cover_url,
                   phone, whatsapp, website, is_verified, is_business,
                   followers_count, following_count, videos_count,
                   total_likes, total_views, created_at`,
        [
          cleanEmail,
          cleanUsername,
          passwordHash,
          displayName ? String(displayName).trim() : username,
          phone ? String(phone).trim() : null,
          verificationToken,
          verificationExpires,
        ]
      );
      const user = result.rows[0];

      // Non-blocking asynchronous SMTP outbound communication trace
      sendVerificationEmail(user.email, user.username, verificationToken).catch((err) => {
        console.error("[SMTP Dispatched Error Handling]: Verification failed:", err.message);
      });

      const tokens = generateTokens(user.id);

      return success(
        {
          user,
          token: tokens.accessToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          ...tokens,
          message: "Registration successful. Please verify your account via the sent email link.",
        },
        event,
        201
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /verify-email — Email Activation Route
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/verify-email" && method === "GET") {
      const token = event.queryStringParameters && event.queryStringParameters.token;
      if (!token) {
        return error("Verification validation token parameter is required.", event, 400);
      }

      const result = await query(
        `SELECT id, email, username, email_verification_expires
         FROM users
         WHERE email_verification_token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return error("The verification token is invalid or has already been consumed.", event, 400);
      }

      const user = result.rows[0];

      if (new Date() > new Date(user.email_verification_expires)) {
        return error("Verification token timeframe has expired. Please request a new transaction link.", event, 400);
      }

      // Transition the verification layout state securely
      await query(
        `UPDATE users
         SET is_verified = TRUE,
             email_verified_at = NOW(),
             email_verification_token = NULL,
             email_verification_expires = NULL
         WHERE id = $1`,
        [user.id]
      );

      return success({ message: "Email address verified successfully. Account unlocked." }, event);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /resend-verification — Regenerate Email Token
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/resend-verification" && method === "POST") {
      const { email } = parseBody(event);
      if (!email) {
        return error("Target validation email address is missing.", event, 400);
      }

      const cleanEmail = String(email).trim().toLowerCase();
      const result = await query(
        "SELECT id, email, username, is_verified, email_verification_token, email_verification_expires FROM users WHERE email = $1",
        [cleanEmail]
      );

      // MITIGATION: Obfuscates application profiles against targeted enum indexing harvesting attacks
      if (result.rows.length === 0 || result.rows[0].is_verified) {
        return success(
          { message: "If this email exists and remains unverified, an activation thread has been transmitted." },
          event
        );
      }

      const user = result.rows[0];
      let tokenToSend = user.email_verification_token;
      let expiresToSend = user.email_verification_expires;

      if (!tokenToSend || !expiresToSend || new Date() > new Date(expiresToSend)) {
        tokenToSend = uuidv4();
        expiresToSend = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await query(
          `UPDATE users
           SET email_verification_token = $1,
               email_verification_expires = $2
           WHERE id = $3`,
          [tokenToSend, expiresToSend, user.id]
        );
      }

      sendVerificationEmail(user.email, user.username, tokenToSend).catch((err) => {
        console.error("[SMTP Dispatched Error Handling]: Retry link failed:", err.message);
      });

      return success(
        { message: "If this email exists and remains unverified, an activation thread has been transmitted." },
        event
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /login — Cleartext Token Acquisition Portal
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/login" && method === "POST") {
      const { emailOrUsername, password } = parseBody(event);

      if (!emailOrUsername || !password) {
        return error("Credentials entry payload definitions are incomplete.", event, 400);
      }

      const lookupIdentity = String(emailOrUsername).trim().toLowerCase();
      const result = await query(
        "SELECT * FROM users WHERE email = $1 OR username = $1",
        [lookupIdentity]
      );
      
      if (result.rows.length === 0) {
        return error("Invalid credential signatures evaluated.", event, 401);
      }

      const user = result.rows[0];
      const isValidPassphrase = await compare(password, user.password_hash);
      if (!isValidPassphrase) {
        return error("Invalid credential signatures evaluated.", event, 401);
      }

      const emailVerifiedStatus = !!user.is_verified;

      // Project clean surface profile structure manually (Prevents accidental field leak mutations)
      const formattedUserProfile = {
        id: user.id,
        email: user.email,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio || null,
        avatar_url: user.avatar_url || null,
        cover_url: user.cover_url || null,
        phone: user.phone || null,
        whatsapp: user.whatsapp || null,
        website: user.website || null,
        location: user.location || null,
        is_verified: emailVerifiedStatus,
        is_business: !!user.is_business,
        followers_count: user.followers_count || 0,
        following_count: user.following_count || 0,
        videos_count: user.videos_count || 0,
        total_likes: user.total_likes || 0,
        total_views: user.total_views || 0,
        created_at: user.created_at
      };

      const tokens = generateTokens(user.id);

      return success(
        {
          user: formattedUserProfile,
          token: tokens.accessToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          ...tokens,
          ...(!emailVerifiedStatus ? { warning: "Please verify your email address to unlock all platform features." } : {}),
        },
        event
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /refresh — Core Token Rotations
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/refresh" && method === "POST") {
      const { refreshToken } = parseBody(event);
      if (!refreshToken) return error("Session execution refresh token required.", event, 400);

      let decoded;
      try {
        decoded = verify(refreshToken, process.env.JWT_SECRET);
      } catch (tokenErr) {
        return error("Session token structure is invalid or has expired.", event, 401);
      }

      // CRITICAL SECURITY FIX: Explicitly block malicious access-token substitutions
      if (!decoded || decoded.type !== "refresh") {
        return error("Invalid cryptographic session structural assignment.", event, 401);
      }

      const result = await query(
        `SELECT id, email, username, display_name, bio, avatar_url, cover_url,
                phone, whatsapp, website, location,
                is_verified, is_business, followers_count, following_count,
                videos_count, total_likes, total_views, created_at
         FROM users WHERE id = $1`,
        [decoded.userId]
      );
      if (result.rows.length === 0) return error("Associated target profile metadata missing.", event, 404);

      const tokens = generateTokens(decoded.userId);
      return success(
        {
          user: result.rows[0],
          token: tokens.accessToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          ...tokens,
        },
        event
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /forgot-password — Lifecycle Identification Dispatches
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/forgot-password" && method === "POST") {
      const { email } = parseBody(event);
      if (!email) return error("Account email identification parameter missing.", event, 400);

      const cleanEmail = String(email).trim().toLowerCase();
      const result = await query(
        "SELECT id, email, username FROM users WHERE email = $1",
        [cleanEmail]
      );

      if (result.rows.length > 0) {
        const user = result.rows[0];
        const resetToken = uuidv4();
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 Hour Frame Window

        await query(
          `UPDATE users
           SET password_reset_token = $1,
               password_reset_expires = $2
           WHERE id = $3`,
          [resetToken, resetExpires, user.id]
        );

        sendPasswordResetEmail(user.email, user.username, resetToken).catch((err) => {
          console.error("[SMTP Dispatched Error Handling]: Reset delivery failed:", err.message);
        });
      }

      // Constant execution outcome context protects privacy records maps
      return success(
        { message: "If this record exists, a verification recovery path has been dispatched." },
        event
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /reset-password — Core Credential Mutators
    // ─────────────────────────────────────────────────────────────────────────
    if (path === "/reset-password" && method === "POST") {
      const { token, newPassword } = parseBody(event);
      if (!token || !newPassword) {
        return error("Token signatures and raw password targets must be defined.", event, 400);
      }
      if (newPassword.length < 8) {
        return error("Password length must contain at least 8 alphanumeric characters.", event, 400);
      }

      const result = await query(
        `SELECT id, password_reset_expires
         FROM users
         WHERE password_reset_token = $1`,
         [token]
      );

      if (result.rows.length === 0) {
        return error("The recovery reset token is invalid or has expired.", event, 400);
      }

      const user = result.rows[0];
      if (new Date() > new Date(user.password_reset_expires)) {
        return error("The token allocation window has closed. Request a new password update thread.", event, 400);
      }

      const complexPasswordHash = await hash(newPassword, 12);
      
      await query(
        `UPDATE users
         SET password_hash = $1,
             password_reset_token = NULL,
             password_reset_expires = NULL
         WHERE id = $2`,
        [complexPasswordHash, user.id]
      );

      return success({ message: "Password mutated successfully. Account unlocked." }, event);
    }

    return error("Requested authorization route path context not found.", event, 404);
  } catch (err) {
    console.error("Central Cryptographic Auth Subsystem Exception:", err);
    // Unifies and routes both runtime validation properties and custom system boundaries safely
    const statusCode = err.status || err.statusCode || 500;
    return error(err.message || "Internal identity microservice routing breakdown", event, statusCode);
  }
}