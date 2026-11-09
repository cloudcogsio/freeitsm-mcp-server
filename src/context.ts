import type { FreeItsmClient, HttpMethod, Query, RequestOptions } from "./api.js";
import { normalisePath, type Access, type Catalogue, type Endpoint } from "./catalogue.js";
import type { Config } from "./config.js";

/** Shared by every server instance: created once at startup. */
export interface Deps {
  config: Config;
  client: FreeItsmClient;
  catalogue: Catalogue;
  access: Access;
}

/** The endpoint for method + template, if this server may call it. */
export function permitted(deps: Deps, method: HttpMethod, template: string): Endpoint | undefined {
  const ep = deps.catalogue.find(method, template);
  return deps.access.allows(ep) ? ep : undefined;
}

/** Query parameters written into the path ("/tickets?q=x"), repeated keys kept. */
function inlineQuery(path: string): Query {
  const q = path.indexOf("?");
  if (q < 0) return {};
  const params = new URLSearchParams(path.slice(q + 1).split("#")[0]);
  const out: Query = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

/**
 * Call an endpoint after checking it locally, so a refusal comes back as a clear
 * message instead of a round trip. FreeITSM checks again on its side. The path
 * sent is exactly the normalised path that was checked.
 */
export async function call(deps: Deps, method: HttpMethod, path: string, opts: RequestOptions = {}) {
  const clean = normalisePath(path);
  const ep = deps.catalogue.find(method, clean);
  if (!ep) {
    const others = deps.catalogue.methodsFor(clean);
    throw new Error(
      others.length
        ? `${method} is not supported on ${clean}. It accepts: ${others.join(", ")}.`
        : `${clean} is not a FreeITSM API endpoint. Use freeitsm_list_endpoints to find the right path.`,
    );
  }
  const availability = deps.access.check(ep);
  if (!availability.ok) {
    throw new Error(`Not allowed: ${method} ${ep.path} is unavailable because ${availability.reason}.`);
  }
  // An explicit query wins over one written into the path.
  return deps.client.request(method, clean, { ...opts, query: { ...inlineQuery(path), ...opts.query } });
}
