/**
 * The one HTTP client every tool uses. FreeITSM enforces the key's permissions,
 * company scope, expiry and rate limit itself; this client only carries the key
 * and turns refusals into messages a model can act on.
 */
import type { Config } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | QueryValue[]>;

/** Largest download returned through MCP. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Query names never forwarded: FreeITSM's front controller treats ?path= as the
 * route when the URL has none, which would call a different endpoint than the one checked.
 */
const RESERVED_QUERY = new Set(["path"]);

export interface RequestOptions {
  query?: Query;
  /** JSON body */
  body?: unknown;
  /** multipart body (file uploads); takes precedence over body */
  form?: FormData;
  signal?: AbortSignal;
}

export type ApiResponse =
  | { kind: "json"; status: number; data: unknown; meta?: PaginationMeta; raw: unknown }
  | { kind: "text"; status: number; contentType: string; text: string }
  | { kind: "binary"; status: number; contentType: string; bytes: Uint8Array; filename?: string; tooLarge?: boolean; size?: number };

export interface PaginationMeta {
  page?: number;
  per_page?: number;
  total?: number;
  total_pages?: number;
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly apiMessage: string,
    readonly details?: unknown,
    retryAfter?: string | null,
  ) {
    super(describeError(status, code, apiMessage, details, retryAfter));
  }
}

function describeError(status: number, code: string, message: string, details: unknown, retryAfter?: string | null): string {
  const head = `FreeITSM refused the request (HTTP ${status}, ${code}): ${message}`;
  const extra = details ? `\nDetails: ${JSON.stringify(details)}` : "";
  let hint = "";
  switch (status) {
    case 400:
    case 422:
      hint = "Check the arguments against freeitsm_describe_endpoint and try again.";
      break;
    case 401:
      hint = "The API key is missing or invalid. Check FREEITSM_API_KEY.";
      break;
    case 403:
      hint = "The API key is not allowed to do this (missing permission, company outside its scope, disabled or expired key). An administrator can change the key under System > API; do not retry.";
      break;
    case 404:
      hint = "Nothing with that id exists, or it is outside the key's company scope. Search first to find a valid id.";
      break;
    case 409:
      hint = "The record changed or conflicts with existing data. Re-read it and try again.";
      break;
    case 429:
      hint = `The key's rate limit was reached. Wait ${retryAfter ? `${retryAfter} seconds` : "a minute"} before more requests.`;
      break;
    default:
      if (status >= 300 && status < 400) {
        hint = "FREEITSM_URL probably points at an address that redirects (for example http to https). Set it to the final address.";
      } else if (status >= 500) {
        hint = "FreeITSM had a server error. Try again later; if it persists, check the server logs.";
      }
  }
  return [head + extra, hint].filter(Boolean).join("\n");
}

function decodeFilename(disposition: string): string | undefined {
  const raw = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Read a body up to `limit` bytes; null when it is larger. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class FreeItsmClient {
  private readonly basePath: string;

  constructor(private readonly config: Config) {
    this.basePath = new URL(config.apiBase).pathname.replace(/\/+$/, "");
  }

  get apiBase(): string {
    return this.config.apiBase;
  }

  /** Fetch a public document (OpenAPI etc.) with no key. */
  async getPublic(path: string): Promise<unknown> {
    const res = await this.fetch(`${this.config.apiBase}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  /** `path` must already be a normalised API path (see normalisePath). */
  async request(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const url = new URL(this.config.apiBase + (path.startsWith("/") ? path : `/${path}`));
    // Defence in depth: the URL actually requested must be the path that was checked.
    const expected = this.basePath + (path === "/" ? "/" : path);
    if (url.pathname !== expected && !(path === "/" && url.pathname === this.basePath)) {
      throw new Error(`Refusing to call ${url.pathname}: it is not the API path ${path}.`);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (RESERVED_QUERY.has(k.toLowerCase())) {
        throw new Error(`The query parameter "${k}" is not allowed: FreeITSM would treat it as a different route.`);
      }
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item === undefined || item === null || item === "") continue;
        url.searchParams.append(k, String(item));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      "User-Agent": "freeitsm-mcp-server",
    };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await this.fetch(url, { method, headers, body, signal: opts.signal });
    const contentType = res.headers.get("content-type") ?? "";

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get("location");
      throw new ApiError(res.status, "redirect", `The server redirected the request${location ? ` to ${location}` : ""}.`);
    }

    if (contentType.includes("json")) {
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        if (!res.ok) throw new ApiError(res.status, "invalid_response", text.slice(0, 500));
        throw new Error(`FreeITSM returned invalid JSON for ${method} ${path}.`);
      }
      if (!res.ok) {
        const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        throw new ApiError(res.status, err?.code ?? "error", err?.message ?? res.statusText, err?.details, res.headers.get("retry-after"));
      }
      const obj = parsed as { data?: unknown; meta?: PaginationMeta } | null;
      if (obj && typeof obj === "object" && "data" in obj) {
        return { kind: "json", status: res.status, data: obj.data, meta: obj.meta, raw: parsed };
      }
      return { kind: "json", status: res.status, data: parsed, raw: parsed };
    }

    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, "error", text.slice(0, 500) || res.statusText, undefined, res.headers.get("retry-after"));
    }
    if (contentType.startsWith("text/") || contentType === "" || contentType.includes("xml")) {
      const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
      return {
        kind: "text",
        status: res.status,
        contentType,
        text: bytes ? new TextDecoder().decode(bytes) : `[The response is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB and was not read.]`,
      };
    }
    const filename = decodeFilename(res.headers.get("content-disposition") ?? "");
    const size = Number(res.headers.get("content-length") ?? NaN);
    const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
    if (!bytes) {
      return { kind: "binary", status: res.status, contentType, bytes: new Uint8Array(), filename, tooLarge: true, size: Number.isFinite(size) ? size : undefined };
    }
    return { kind: "binary", status: res.status, contentType, bytes, filename };
  }

  private async fetch(url: string | URL, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      // Never follow redirects: the key must only go to FREEITSM_URL.
      return await fetch(url, { ...init, signal, redirect: "manual" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`FreeITSM did not answer within ${this.config.timeoutMs / 1000} seconds. Try again, or narrow the request.`);
      }
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error(`Could not reach FreeITSM at ${this.config.apiBase}: ${(error as Error).message}`);
    }
  }
}
