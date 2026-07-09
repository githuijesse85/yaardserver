/**
 * @fileoverview Shared HTTP middleware helpers for Netlify functions.
 *
 * Provides CORS handling, standardised JSON responses, JWT authentication,
 * and request body parsing.
 */

import { verify } from "jsonwebtoken";

// ── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, Accept, Origin",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Call this at the top of every handler before any other logic.
 *
 * @param {object} event - Netlify function event
 * @returns {object|null} A 204 CORS response, or null if not a preflight
 */
export function handleCors(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }
  return null;
}

// ── RESPONSE HELPERS ──────────────────────────────────────────────────────────

/**
 * Return a standardised success response.
 *
 * @param {any} data - Response payload
 * @param {object} _event - Netlify event (reserved for future header inspection)
 * @param {number} [statusCode=200]
 */
export function success(data, _event, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({ success: true, data }),
  };
}

/**
 * Return a standardised error response.
 *
 * @param {string} message - Human-readable error message
 * @param {object} _event - Netlify event (reserved for future header inspection)
 * @param {number} [statusCode=500]
 */
export function error(message, _event, statusCode = 500) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({ success: false, error: message }),
  };
}

// ── AUTHENTICATION ────────────────────────────────────────────────────────────

/**
 * Extract and verify the Bearer JWT from the Authorization header.
 * Throws a 401 error (with a statusCode property) if missing or invalid.
 *
 * @param {object} event - Netlify function event
 * @returns {{ userId: string }} Verified token payload
 */
export function requireAuth(event) {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    const err = new Error("Server authentication is not configured.");
    err.statusCode = 503;
    throw err;
  }

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    const err = new Error("Authorization header missing or malformed.");
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.slice(7).trim();

  try {
    const payload = verify(token, JWT_SECRET);

    if (!payload || !payload.userId) {
      const err = new Error("Invalid token payload.");
      err.statusCode = 401;
      throw err;
    }

    return { userId: String(payload.userId) };
  } catch (verifyErr) {
    if (verifyErr.statusCode) throw verifyErr;

    const err = new Error(
      verifyErr.name === "TokenExpiredError"
        ? "Session expired. Please log in again."
        : "Invalid or tampered token."
    );
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Attempt to extract the authenticated user without throwing.
 * Returns null if the request is unauthenticated.
 *
 * @param {object} event - Netlify function event
 * @returns {{ userId: string } | null}
 */
export function optionalAuth(event) {
  try {
    return requireAuth(event);
  } catch {
    return null;
  }
}

// ── BODY PARSING ──────────────────────────────────────────────────────────────

/**
 * Parse the request body as JSON. Returns an empty object on failure.
 *
 * @param {object} event - Netlify function event
 * @returns {object}
 */
export function parseBody(event) {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
