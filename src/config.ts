/**
 * Settings, read once from the environment.
 *
 *   FREEITSM_URL          base URL of the FreeITSM install, e.g. https://itsm.example.com
 *                         (a URL ending in /api/v1 is accepted too)
 *   FREEITSM_API_KEY      an API key from System > API. What the key may do is all this server may do.
 *   FREEITSM_READ_ONLY    true/false (also 1/0, yes/no, on/off). true hides every write tool.
 *                         Any other value is refused, so a typo never leaves the server writable.
 *   FREEITSM_UPLOAD_DIR   folder that freeitsm_upload_change_evidence may read local files from.
 *                         Unset: local files cannot be uploaded at all (base64 content still can).
 *   FREEITSM_UPLOAD_MAX_MB  largest upload accepted, default 20
 *   FREEITSM_TIMEOUT_MS   per-request timeout, default 30000
 */
import { realpathSync, statSync } from "node:fs";

export interface Config {
  /** e.g. https://itsm.example.com/api/v1 (no trailing slash, no query) */
  apiBase: string;
  apiKey: string;
  readOnly: boolean;
  /** real path of the upload folder, or null when local-file uploads are off */
  uploadDir: string | null;
  uploadMaxBytes: number;
  timeoutMs: number;
  /** non-fatal problems to report at startup */
  warnings: string[];
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["", "0", "false", "no", "off"]);

export function parseBoolean(name: string, value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new Error(`${name} must be true or false (got "${value}").`);
}

function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got "${value}").`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = (env.FREEITSM_URL ?? "").trim();
  const apiKey = (env.FREEITSM_API_KEY ?? "").trim();
  const missing = [!url && "FREEITSM_URL", !apiKey && "FREEITSM_API_KEY"].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}. See README.md.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`FREEITSM_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`FREEITSM_URL must start with https:// or http:// (got ${parsed.protocol}).`);
  }

  const warnings: string[] = [];
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    warnings.push(`FREEITSM_URL uses plain http to ${parsed.hostname}: the API key is sent unencrypted. Use https.`);
  }

  let base = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  if (!/\/api\/v1$/.test(base)) base += "/api/v1";

  let uploadDir: string | null = null;
  const rawDir = (env.FREEITSM_UPLOAD_DIR ?? "").trim();
  if (rawDir) {
    try {
      uploadDir = realpathSync(rawDir);
    } catch {
      throw new Error(`FREEITSM_UPLOAD_DIR does not exist: ${rawDir}`);
    }
    if (!statSync(uploadDir).isDirectory()) throw new Error(`FREEITSM_UPLOAD_DIR is not a folder: ${rawDir}`);
  }

  return {
    apiBase: base,
    apiKey,
    readOnly: parseBoolean("FREEITSM_READ_ONLY", env.FREEITSM_READ_ONLY),
    uploadDir,
    uploadMaxBytes: Math.round(positiveNumber("FREEITSM_UPLOAD_MAX_MB", env.FREEITSM_UPLOAD_MAX_MB, 20) * 1024 * 1024),
    timeoutMs: positiveNumber("FREEITSM_TIMEOUT_MS", env.FREEITSM_TIMEOUT_MS, 30_000),
    warnings,
  };
}
