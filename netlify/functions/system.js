import "../../shared/env.js";
import { promises as fs } from "fs";
import { resolve } from "path";
import { verify } from "jsonwebtoken";
import { success, error, handleCors, parseBody } from "../../shared/middleware.js";

const ROOT_CONFIG_FILE = resolve(process.cwd(), "system-config.json");
const CANDIDATE_CONFIG_PATHS = [
  process.env.SYSTEM_CONFIG_PATH ? resolve(process.env.SYSTEM_CONFIG_PATH) : null,
  ROOT_CONFIG_FILE,
  resolve(process.cwd(), "system-config.json"),
  resolve(process.cwd(), "../system-config.json"),
  resolve(process.cwd(), "../../system-config.json"),
].filter(Boolean);
const FALLBACK_CONFIG_PATH = resolve(
  process.platform === "win32" ? process.env.TEMP || "C:\\Windows\\Temp" : "/tmp",
  "system-config.json"
);
const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_UPDATE_URL = process.env.UPDATE_URL || "https://play.google.com/store/apps/details?id=com.yaard.app";

const DEFAULT_SYSTEM_CONFIG = {
  latest_version: process.env.SYSTEM_LATEST_VERSION || "4.6.1",
  version_code: Number(process.env.SYSTEM_VERSION_CODE || 47),
  force_update: process.env.SYSTEM_FORCE_UPDATE === "false" || false,
  maintenance_mode: process.env.SYSTEM_MAINTENANCE_MODE === "false" || false,
  update_url: DEFAULT_UPDATE_URL,
  update_message: process.env.SYSTEM_UPDATE_MESSAGE || "A improved media playback controls in feed.Upload issues fixed.Whatsapp phone number validation improved.User profile experience improved.",
  release_notes: process.env.SYSTEM_RELEASE_NOTES || "A improved media playback controls in feed.Upload issues fixed.Whatsapp phone number validation improved.User profile experience improved.",
  features_enabled: {
    ads: process.env.SYSTEM_FEATURE_ADS !== "false",
    reporting: process.env.SYSTEM_FEATURE_REPORTING !== "false",
    dynamic_forms: process.env.SYSTEM_FEATURE_DYNAMIC_FORMS !== "false",
  },
  build_date: process.env.SYSTEM_BUILD_DATE || new Date().toISOString(),
};

function getAdminToken(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  if (!auth.startsWith("Bearer ")) {
    throw new Error("Admin authentication required");
  }
  return auth.split(" ")[1];
}

function verifyAdminToken(event) {
  if (!JWT_SECRET) {
    const err = new Error("JWT_SECRET is not configured on the server");
    err.statusCode = 503;
    throw err;
  }

  const token = getAdminToken(event);
  let payload;
  try {
    payload = verify(token, JWT_SECRET);
  } catch (err) {
    const authErr = new Error(err.name === "TokenExpiredError" ? "Admin token expired" : "Invalid admin token");
    authErr.statusCode = 401;
    throw authErr;
  }

  if (!payload || payload.role !== "admin") {
    const authErr = new Error("Invalid admin credentials");
    authErr.statusCode = 401;
    throw authErr;
  }

  return payload;
}

function normalizeConfig(config) {
  return {
    ...DEFAULT_SYSTEM_CONFIG,
    ...config,
    features_enabled: {
      ...DEFAULT_SYSTEM_CONFIG.features_enabled,
      ...(config.features_enabled || {}),
    },
    version_code: Number(config.version_code) || DEFAULT_SYSTEM_CONFIG.version_code,
    force_update: Boolean(config.force_update),
    maintenance_mode: Boolean(config.maintenance_mode),
    build_date: config.build_date || DEFAULT_SYSTEM_CONFIG.build_date,
  };
}

async function findExistingConfigPath() {
  for (const candidate of CANDIDATE_CONFIG_PATHS) {
    try {
      const fileContents = await fs.readFile(candidate, "utf8");
      return { path: candidate, contents: fileContents };
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        continue;
      }
      console.warn(`[System Config] Unable to read config from ${candidate}: ${err.message}`);
      continue;
    }
  }
  return null;
}

async function resolveWritePath() {
  if (process.env.SYSTEM_CONFIG_PATH) {
    return resolve(process.env.SYSTEM_CONFIG_PATH);
  }

  for (const candidate of CANDIDATE_CONFIG_PATHS) {
    if (candidate === FALLBACK_CONFIG_PATH) continue;
    try {
      const parentDir = dirname(candidate);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.access(parentDir, fs.constants.W_OK);
      return candidate;
    } catch (err) {
      continue;
    }
  }

  return FALLBACK_CONFIG_PATH;
}

async function loadSystemConfig() {
  const result = await findExistingConfigPath();
  if (!result) {
    return {
      ...normalizeConfig({}),
      config_path: null,
      config_source: "defaults"
    };
  }

  try {
    const storedConfig = JSON.parse(result.contents || "{}");
    return {
      ...normalizeConfig(storedConfig),
      config_path: result.path,
      config_source: "file"
    };
  } catch (err) {
    console.error("[System Config Load Error]: Failed to parse JSON from", result.path, err.message);
    throw err;
  }
}

async function persistSystemConfig(config) {
  const sanitizedConfig = normalizeConfig(config);
  const primaryPath = await resolveWritePath();
  const payload = JSON.stringify(sanitizedConfig, null, 2);

  try {
    await fs.mkdir(dirname(primaryPath), { recursive: true });
    await fs.writeFile(primaryPath, payload, "utf8");
    const savedPath = primaryPath;
    if (primaryPath === FALLBACK_CONFIG_PATH && !process.env.SYSTEM_CONFIG_PATH) {
      console.warn(`[System Config] Root config path is not writable. Persisted to temporary runtime path: ${primaryPath}`);
    }
    return { ...sanitizedConfig, saved_path: savedPath };
  } catch (err) {
    console.warn(`[System Config] Failed to write to configured path ${primaryPath}: ${err.message}`);
    if (primaryPath !== FALLBACK_CONFIG_PATH) {
      await fs.mkdir(dirname(FALLBACK_CONFIG_PATH), { recursive: true });
      await fs.writeFile(FALLBACK_CONFIG_PATH, payload, "utf8");
      console.warn(`[System Config] Persisted to fallback temporary path: ${FALLBACK_CONFIG_PATH}`);
      return { ...sanitizedConfig, saved_path: FALLBACK_CONFIG_PATH };
    }
    throw err;
  }
}

/**
 * GET /api/system/config
 * POST /api/system/config
 * Returns and persists app configuration for client update checks.
 */
export async function handler(event, context) {
  // CRITICAL FIX: Releases processing loops instantly
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  const corsRes = handleCors(event);
  if (corsRes) return corsRes;

  try {
    const path = event.path.replace(/\.netlify\/functions\/system/, "/api/system");
    const method = event.httpMethod;
    const body = parseBody(event);

    if (path === "/api/system/config" && method === "GET") {
      const config = await loadSystemConfig();
      return success({ ...config, checked_at: new Date().toISOString() }, event);
    }

    if (path === "/api/system/config" && method === "POST") {
      verifyAdminToken(event);
      const currentConfig = await loadSystemConfig();
      const updatedConfig = {
        ...currentConfig,
        latest_version: body.latest_version || currentConfig.latest_version,
        version_code: body.version_code !== undefined ? Number(body.version_code) : currentConfig.version_code,
        force_update: body.force_update !== undefined ? Boolean(body.force_update) : currentConfig.force_update,
        maintenance_mode: body.maintenance_mode !== undefined ? Boolean(body.maintenance_mode) : currentConfig.maintenance_mode,
        update_url: body.update_url || currentConfig.update_url,
        update_message: body.update_message || currentConfig.update_message,
        release_notes: body.release_notes || currentConfig.release_notes,
        features_enabled: {
          ...currentConfig.features_enabled,
          ...(body.features_enabled || {}),
        },
        build_date: body.build_date || currentConfig.build_date,
      };

      const savedConfig = await persistSystemConfig(updatedConfig);
      return success({
        ...savedConfig,
        saved_at: new Date().toISOString(),
        config_path: savedConfig.saved_path || null
      }, event);
    }

    return error("Requested system route not found", event, 404);
  } catch (err) {
    console.error("[System API Error]:", err);
    return error(err.message || "Internal Server Error", event, err.statusCode || 500);
  }
}
