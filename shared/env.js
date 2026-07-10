/**
 * @fileoverview Environment variable loader.
 * Loads .env in development; in production (Netlify) vars are injected by the platform.
 */

import dotenv from "dotenv";

// Only load dotenv in non-production environments to avoid overriding Netlify's env injection
if (process.env.NODE_ENV !== "production") {
  try {
    dotenv.config();
  } catch {
    // dotenv is optional — ignore if missing
  }
}

/**
 * Retrieves a required environment variable, throwing a descriptive error if absent.
 * @param {string} key - Environment variable name
 * @param {string} [fallback] - Optional default value
 * @returns {string}
 */
export function getEnv(key, fallback) {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value;
}

export default {};
