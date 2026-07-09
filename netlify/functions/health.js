/**
 * @fileoverview Health check endpoint for the Yaard API.
 * Verifies API responsiveness and database connectivity.
 */

import { query } from "../../shared/db";
import { handleCors, success, error } from "../../shared/middleware";

export async function handler(event, context) {
  // CRITICAL FIX: Prevents idle DB connection from hanging the function thread.
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  // 1. Handle CORS preflight and headers
  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  try {
    // 2. Test database connection (destructuring rows directly)
    const { rows } = await query("SELECT NOW() as time");

    // 3. Return healthy payload
    return success({
      status: "healthy",
      version: "1.0.0",
      app: "Yaard API",
      timestamp: new Date().toISOString(),
      database: { 
        connected: true, 
        time: rows[0].time 
      },
    }, event);

  } catch (err) {
    // 4. Log the error internally for debugging, then return a 503 response
    console.error("[Health Check Error] Database connection failed:", err);
    
    return error(`Database connection failed: ${err.message}`, event, 503);
  }
}