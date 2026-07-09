/**
 * @fileoverview Shared PostgreSQL connection pool for all Netlify functions.
 *
 * Uses a module-level singleton so the pool is reused across warm invocations.
 * context.callbackWaitsForEmptyEventLoop = false must be set in each handler
 * so Netlify does not wait for the idle pool to drain between requests.
 */

import pg from "pg";

const { Pool } = pg;

// Netlify functions are ephemeral — keep pool small to avoid exhausting
// Supabase's connection limit.
const MAX_POOL_CONNECTIONS = 3;

let pool = null;

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[DB] DATABASE_URL environment variable is not set. " +
        "Set it in Netlify Site Settings → Environment variables."
    );
  }

  const sslRejectUnauthorized =
    String(process.env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase() !== "false";

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: MAX_POOL_CONNECTIONS,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    ssl: {
      rejectUnauthorized: sslRejectUnauthorized,
    },
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();

    pool.on("error", (err) => {
      console.error("[DB Pool] Unexpected idle client error:", err.message);
      // Reset pool on critical error so it is recreated on the next request
      pool = null;
    });
  }
  return pool;
}

/**
 * Execute a parameterized SQL query against the shared connection pool.
 *
 * @param {string} text - SQL query string with $1..$N placeholders
 * @param {any[]} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    const duration = Date.now() - start;
    if (duration > 2000) {
      console.warn(`[DB] Slow query (${duration}ms): ${text.slice(0, 120)}`);
    }
    return result;
  } catch (err) {
    console.error("[DB] Query error:", {
      message: err.message,
      query: text.slice(0, 200),
      params: params ? "[redacted]" : undefined,
    });
    throw err;
  }
}

/**
 * Run multiple queries inside a single transaction.
 * Automatically rolls back on error.
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn - Callback receiving the transaction client
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
