/**
 * The endpoint catalogue, built at startup from the install's own description
 * of its API, so it always matches the FreeITSM version being talked to:
 *
 *   GET /api/v1/openapi.json  (public) - paths, parameters, request examples
 *   GET /api/v1/spec.json     (public) - the permission each endpoint needs
 *
 * If spec.json is unavailable, the permission is read from the OpenAPI 403
 * response text ("The key does not have the tickets.read permission.").
 * An endpoint whose permission cannot be determined is treated as unavailable
 * (fail closed). FreeITSM enforces the key on every call regardless.
 */
import type { FreeItsmClient, HttpMethod } from "./api.js";

export interface Param {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
}

export interface BodyField {
  name: string;
  required: boolean;
  description: string;
}

export interface Endpoint {
  method: HttpMethod;
  /** path template relative to /api/v1, e.g. /tickets/{id}/notes */
  path: string;
  summary: string;
  description: string;
  section: string;
  /** "tickets.read"; null = any valid key; undefined = could not be determined */
  permission: string | null | undefined;
  params: Param[];
  bodyFields: BodyField[];
  bodyExamples: { summary?: string; value: unknown }[];
  multipart: boolean;
  matcher: RegExp;
}

export interface KeyInfo {
  name: string;
  actsAs: string | null;
  /** resource -> allowed actions */
  permissions: Record<string, string[]>;
  /** null = every company the analyst can reach */
  companies: { id: number; name: string }[] | null;
  expiresAt: string | null;
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const WRITE_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths left out of the catalogue. "/" is the API's index page; it also routes a
 * ?path= query parameter to other endpoints, which would get round the local check.
 */
const EXCLUDED_PATHS = new Set(["/"]);

type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
  requestBody?: { content?: Record<string, { examples?: Record<string, { summary?: string; value?: unknown }> }> };
  responses?: Record<string, { description?: string }>;
};
type SpecItem = { m: string; p: string; perm?: string; params?: { name: string; in: string; req?: boolean; desc?: string }[] };

export class Catalogue {
  private constructor(
    readonly endpoints: Endpoint[],
    /** Problems found while loading, for the startup log. */
    readonly warnings: string[],
  ) {}

  static async load(client: FreeItsmClient): Promise<Catalogue> {
    const warnings: string[] = [];
    const [openapi, spec] = await Promise.all([
      client.getPublic("/openapi.json"),
      client.getPublic("/spec.json").catch((e: Error) => {
        warnings.push(`spec.json could not be loaded (${e.message}); permissions are read from the OpenAPI document instead.`);
        return null;
      }),
    ]);
    const catalogue = Catalogue.fromDocuments(openapi, spec);
    catalogue.warnings.unshift(...warnings);
    return catalogue;
  }

  static fromDocuments(openapi: unknown, spec: unknown): Catalogue {
    const paths = (openapi as { paths?: Record<string, Record<string, OpenApiOperation>> })?.paths;
    if (!paths) throw new Error("The FreeITSM OpenAPI document has no paths. Is FREEITSM_URL pointing at a FreeITSM install?");

    const specByKey = new Map<string, SpecItem>();
    const sections = (spec as { spec?: { items?: SpecItem[] }[] } | null)?.spec ?? [];
    for (const section of sections) for (const item of section.items ?? []) specByKey.set(`${item.m} ${item.p}`, item);

    const endpoints: Endpoint[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      if (EXCLUDED_PATHS.has(path)) continue;
      for (const [m, op] of Object.entries(ops)) {
        const method = m.toUpperCase() as HttpMethod;
        if (!METHODS.includes(method)) continue;
        const item = specByKey.get(`${method} ${path}`);

        let permission: string | null | undefined;
        if (item?.perm) {
          permission = item.perm === "none" ? null : item.perm;
        } else if (op.responses && !op.responses["403"]) {
          permission = null; // documented with no 403: any valid key
        } else {
          const forbidden = op.responses?.["403"]?.description ?? "";
          permission = /does not have the ([a-z0-9_]+\.[a-z0-9_]+) permission/i.exec(forbidden)?.[1];
        }

        const content = op.requestBody?.content ?? {};
        const bodyExamples = Object.values(content).flatMap((c) =>
          Object.values(c.examples ?? {}).map((e) => ({ summary: e.summary, value: e.value })),
        );
        const multipart = "multipart/form-data" in content || /multipart\/form-data/i.test(op.description ?? "");

        endpoints.push({
          method,
          path,
          summary: op.summary ?? "",
          description: op.description ?? "",
          section: op.tags?.[0] ?? "Other",
          permission,
          params: (op.parameters ?? [])
            .filter((p) => p.in === "path" || p.in === "query")
            .map((p) => ({
              name: p.name,
              in: p.in as "path" | "query",
              required: !!p.required,
              description: p.description ?? "",
            })),
          bodyFields: (item?.params ?? [])
            .filter((p) => p.in === "body")
            .map((p) => ({ name: p.name, required: !!p.req, description: p.desc ?? "" })),
          bodyExamples,
          multipart,
          matcher: templateToRegex(path),
        });
      }
    }

    const warnings: string[] = [];
    const unknown = endpoints.filter((e) => e.permission === undefined).length;
    if (unknown) warnings.push(`${unknown} endpoint(s) have no known permission and are treated as unavailable.`);
    return new Catalogue(endpoints, warnings);
  }

  /**
   * Find the endpoint a concrete path (/tickets/42) or a template (/tickets/{id})
   * belongs to. Throws on paths that are not plain API paths (see normalisePath).
   */
  find(method: HttpMethod, path: string): Endpoint | undefined {
    const clean = normalisePath(path, { allowTemplate: true });
    const exact = this.endpoints.find((e) => e.method === method && e.path === clean);
    if (exact) return exact;
    // Prefer literal segments over placeholders: /tickets/trash before /tickets/{id}
    const matches = this.endpoints.filter((e) => e.method === method && e.matcher.test(clean));
    matches.sort((a, b) => placeholders(a.path) - placeholders(b.path));
    return matches[0];
  }

  /** Every method a path accepts (for "did you mean" errors). */
  methodsFor(path: string): HttpMethod[] {
    const clean = normalisePath(path, { allowTemplate: true });
    return this.endpoints.filter((e) => e.path === clean || e.matcher.test(clean)).map((e) => e.method);
  }
}

const SEGMENT = /^[A-Za-z0-9._~:@-]+$/;
const TEMPLATE_SEGMENT = /^\{[A-Za-z0-9_]+\}$/;

/**
 * Reduce a path, "/api/v1/..." path or full URL to a path relative to /api/v1,
 * dropping any query string or fragment. Rejects anything that is not a plain
 * API path - "." and ".." segments, percent-encoding, backslashes, empty
 * segments - so the endpoint that is checked is the endpoint that is called.
 */
export function normalisePath(input: string, opts: { allowTemplate?: boolean } = {}): string {
  let p = input.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      throw new Error(`Not a valid URL: ${input}`);
    }
  }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith("/")) p = `/${p}`;
  // Strip everything up to and including /api/v1 (also on installs under a sub-path).
  const marker = /\/api\/v1(?=\/|$)/.exec(p);
  if (marker) p = p.slice(marker.index + marker[0].length) || "/";
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "/") return p;

  for (const segment of p.slice(1).split("/")) {
    const ok =
      segment !== "." && segment !== ".." && (SEGMENT.test(segment) || (opts.allowTemplate === true && TEMPLATE_SEGMENT.test(segment)));
    if (!ok) {
      throw new Error(
        `"${input}" is not a plain API path (bad segment "${segment}"). Give a path such as /tickets/42, without "..", encoding or special characters.`,
      );
    }
  }
  return p;
}

function templateToRegex(template: string): RegExp {
  const escaped = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`);
}

function placeholders(path: string): number {
  return (path.match(/\{/g) ?? []).length;
}

/** Turns the /ping response into KeyInfo. */
export function parseKeyInfo(ping: unknown): KeyInfo {
  const key = (ping as { key?: Record<string, unknown> } | null)?.key;
  if (!key) throw new Error("Unexpected /ping response from FreeITSM.");
  const rawPerms = key.permissions;
  const permissions: Record<string, string[]> = {};
  if (rawPerms && typeof rawPerms === "object" && !Array.isArray(rawPerms)) {
    for (const [res, actions] of Object.entries(rawPerms as Record<string, unknown>)) {
      if (Array.isArray(actions)) permissions[res] = actions.map(String);
    }
  }
  return {
    name: String(key.name ?? ""),
    actsAs: key.acts_as == null ? null : String(key.acts_as),
    permissions,
    companies: Array.isArray(key.companies) ? (key.companies as { id: number; name: string }[]) : null,
    expiresAt: key.expires_at == null ? null : String(key.expires_at),
  };
}

export type Availability = { ok: true } | { ok: false; reason: string };

/** What this server will let the model do. FreeITSM still checks every call itself. */
export class Access {
  constructor(
    readonly key: KeyInfo,
    readonly readOnly: boolean,
  ) {}

  hasPermission(permission: string | null): boolean {
    if (permission === null) return true;
    const [resource, action] = permission.split(".");
    return this.key.permissions[resource]?.includes(action) ?? false;
  }

  check(endpoint: Endpoint): Availability {
    if (this.readOnly && WRITE_METHODS.has(endpoint.method)) {
      return { ok: false, reason: "this MCP server runs read-only (FREEITSM_READ_ONLY)" };
    }
    if (endpoint.permission === undefined) {
      return { ok: false, reason: "the permission it needs could not be determined from this FreeITSM version" };
    }
    if (!this.hasPermission(endpoint.permission)) {
      return { ok: false, reason: `the API key lacks the ${endpoint.permission} permission` };
    }
    return { ok: true };
  }

  allows(endpoint: Endpoint | undefined): endpoint is Endpoint {
    return !!endpoint && this.check(endpoint).ok;
  }
}
