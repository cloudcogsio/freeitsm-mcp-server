/**
 * Generic access to the whole API: discover, describe, then call. Covers every
 * endpoint the key may use, including ones without a dedicated tool.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { WRITE_METHODS, normalisePath, type Endpoint } from "../catalogue.js";
import { call, type Deps } from "../context.js";
import { CHARACTER_LIMIT, render, text } from "../format.js";

const queryValue = z.union([z.string(), z.number(), z.boolean()]);
const UPLOAD_HINT = "for files use freeitsm_upload_change_evidence or freeitsm_add_project_document where listed";

function line(ep: Endpoint, reason?: string): string {
  return `${ep.method.padEnd(6)} ${ep.path} - ${ep.summary}${reason ? `  [unavailable: ${reason}]` : ""}`;
}

export function registerGenericTools(server: McpServer, deps: Deps): void {
  const { catalogue, access } = deps;
  const endpoints = catalogue.endpoints.filter((e) => e.path !== "/");

  server.registerTool(
    "freeitsm_list_endpoints",
    {
      title: "List API endpoints",
      description: `Find FreeITSM API endpoints this API key can use. Use it when no dedicated freeitsm_* tool fits.

With no arguments it lists the API's sections with counts. Give a section and/or a search term to list endpoints (method, path, summary).
Then call freeitsm_describe_endpoint for parameters and examples, and freeitsm_api_get / freeitsm_api_write to call it.

Examples:
  - "What can I do with contracts?" -> section="Contracts"
  - "Is there anything about CAB votes?" -> search="cab"`,
      inputSchema: z.strictObject({
        section: z.string().optional().describe("Section name or part of it, e.g. 'Tickets', 'Changes', 'CMDB'"),
        search: z.string().optional().describe("Words to look for in the path, summary or description"),
        kind: z.enum(["all", "read", "write"]).default("all").describe("'read' = GET only, 'write' = POST/PUT/PATCH/DELETE only"),
        include_unavailable: z
          .boolean()
          .default(false)
          .describe("Also list endpoints the key may not use, with the reason (e.g. the permission an administrator would need to add)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ section, search, kind, include_unavailable }) => {
      const rows = endpoints
        .filter((e) => kind === "all" || (kind === "write") === WRITE_METHODS.has(e.method))
        .map((e) => ({ e, a: access.check(e) }));

      if (!section && !search) {
        const bySection = new Map<string, { ok: number; blocked: number }>();
        for (const { e, a } of rows) {
          const s = bySection.get(e.section) ?? { ok: 0, blocked: 0 };
          if (a.ok) s.ok++;
          else s.blocked++;
          bySection.set(e.section, s);
        }
        const out = [...bySection.entries()]
          .filter(([, s]) => s.ok > 0 || include_unavailable)
          .map(([name, s]) => `- ${name}: ${s.ok} usable${s.blocked ? `, ${s.blocked} not allowed for this key` : ""}`);
        return text(
          `FreeITSM API sections (${rows.filter((r) => r.a.ok).length} endpoints usable with this key):\n${out.join("\n")}\n\nCall again with section="<name>" to list its endpoints.`,
        );
      }

      const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = rows.filter(({ e, a }) => {
        if (!a.ok && !include_unavailable) return false;
        if (section && !e.section.toLowerCase().includes(section.toLowerCase())) return false;
        const hay = `${e.method} ${e.path} ${e.summary} ${e.description} ${e.section}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const hidden = include_unavailable
        ? 0
        : rows.filter(({ e, a }) => {
            if (a.ok) return false;
            if (section && !e.section.toLowerCase().includes(section.toLowerCase())) return false;
            const hay = `${e.method} ${e.path} ${e.summary} ${e.description} ${e.section}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          }).length;

      if (!hits.length) {
        return text(
          `No usable endpoints match.${hidden ? ` ${hidden} matching endpoint(s) exist but this key may not use them (pass include_unavailable=true to see why).` : ""}`,
        );
      }
      let out = "";
      let current = "";
      for (const { e, a } of hits) {
        if (e.section !== current) {
          current = e.section;
          out += `\n## ${current}\n`;
        }
        out += line(e, a.ok ? undefined : a.reason) + "\n";
        if (out.length > CHARACTER_LIMIT) {
          out += "\n[More endpoints match: narrow the search.]";
          break;
        }
      }
      if (hidden) out += `\n${hidden} more matching endpoint(s) are not allowed for this key (include_unavailable=true shows them).`;
      return text(out.trim());
    },
  );

  server.registerTool(
    "freeitsm_describe_endpoint",
    {
      title: "Describe an API endpoint",
      description: `Show how to call one FreeITSM API endpoint: what it does, the permission it needs, path/query parameters, body fields and request examples.
Accepts a template (/tickets/{id}/notes) or a concrete path (/tickets/42/notes).`,
      inputSchema: z.strictObject({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().min(1).describe("Path under /api/v1, e.g. /changes/{id}/comments"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ method, path }) => {
      const ep = catalogue.find(method, path);
      if (!ep) {
        const others = catalogue.methodsFor(path);
        return text(
          others.length
            ? `${method} ${normalisePath(path, { allowTemplate: true })} does not exist. That path accepts: ${others.join(", ")}.`
            : `No endpoint matches ${normalisePath(path, { allowTemplate: true })}. Use freeitsm_list_endpoints to search.`,
        );
      }
      const a = access.check(ep);
      const parts = [
        `# ${ep.method} ${ep.path}`,
        ep.summary,
        "",
        ep.description,
        "",
        `Section: ${ep.section}`,
        `Permission: ${ep.permission === undefined ? "unknown (treated as unavailable)" : ep.permission ?? "none (any valid key)"}${
          ep.extraPermissions.length ? `, plus ${ep.extraPermissions.join(", ")}` : ""
        }`,
        `Usable with this key: ${a.ok ? "yes" : `no - ${a.reason}`}`,
      ];
      if (ep.multipart) {
        parts.push(
          ep.json
            ? `Body: JSON, or a multipart/form-data file upload (${UPLOAD_HINT}).`
            : `Body: multipart/form-data upload only (${UPLOAD_HINT}).`,
        );
      }
      const pathParams = ep.params.filter((p) => p.in === "path");
      const queryParams = ep.params.filter((p) => p.in === "query");
      if (pathParams.length) parts.push("", "Path parameters:", ...pathParams.map((p) => `- ${p.name}: ${p.description}`));
      if (queryParams.length) {
        parts.push("", "Query parameters:", ...queryParams.map((p) => `- ${p.name}${p.required ? " (required)" : ""}: ${p.description}`));
      }
      if (ep.bodyFields.length) {
        parts.push("", "Body fields (JSON):", ...ep.bodyFields.map((f) => `- ${f.name}${f.required ? " (required)" : ""}: ${f.description}`));
      }
      if (ep.bodyExamples.length) {
        parts.push("", "Body examples:");
        for (const ex of ep.bodyExamples) parts.push(`- ${ex.summary ?? "Example"}: ${JSON.stringify(ex.value)}`);
      }
      const tool = WRITE_METHODS.has(ep.method) ? "freeitsm_api_write" : "freeitsm_api_get";
      parts.push("", `Call it with ${tool}.`);
      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "freeitsm_api_get",
    {
      title: "Read from the API",
      description: `Call any FreeITSM GET endpoint this key may use and return its JSON. Use freeitsm_list_endpoints / freeitsm_describe_endpoint to find the path and parameters.
Lists are paginated with page / per_page (max 100); the result says when there are more pages.

Examples:
  - path="/contracts", query={"q": "Microsoft"}
  - path="/changes/12/comments"
  - path="/cmdb/objects", query={"page": 2, "per_page": 50}`,
      inputSchema: z.strictObject({
        path: z.string().min(1).describe("Concrete path under /api/v1, ids filled in, e.g. /tickets/42/sla"),
        query: z.record(z.string(), queryValue).optional().describe("Query-string parameters"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, query }, ctx) => {
      if (path.includes("{")) return text(`Fill in the placeholders in ${path} with real ids first.`);
      const res = await call(deps, "GET", path, { query, signal: ctx.mcpReq.signal });
      return render(res, `GET ${normalisePath(path)}`);
    },
  );

  const anyWrite = endpoints.some((e) => WRITE_METHODS.has(e.method) && e.json && access.check(e).ok);
  if (!anyWrite) return;

  server.registerTool(
    "freeitsm_api_write",
    {
      title: "Change data through the API",
      description: `Call any FreeITSM POST / PUT / PATCH / DELETE endpoint this key may use, with a JSON body.
Prefer a dedicated freeitsm_* tool when one exists. Always check freeitsm_describe_endpoint first for the body fields.
Writes act as the analyst the key belongs to and are audited like changes made in the UI. DELETE may be permanent - confirm with the user before deleting anything.

Examples:
  - method="POST", path="/changes/12/comments", body={"comment": "CAB approved for Friday"}
  - method="PATCH", path="/problems/7", body={"is_known_error": true}`,
      inputSchema: z.strictObject({
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().min(1).describe("Concrete path under /api/v1, ids filled in"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body; send only the fields to change"),
        query: z.record(z.string(), queryValue).optional().describe("Query-string parameters, rarely needed"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, path, body, query }, ctx) => {
      if (path.includes("{")) return text(`Fill in the placeholders in ${path} with real ids first.`);
      const ep = catalogue.find(method, path);
      if (ep && !ep.json) {
        return text(`${method} ${ep.path} needs a multipart file upload, which this tool cannot send (${UPLOAD_HINT}).`);
      }
      const res = await call(deps, method, path, { body: body ?? (method === "DELETE" ? undefined : {}), query, signal: ctx.mcpReq.signal });
      return render(res, `${method} ${normalisePath(path)} (HTTP ${res.status})`);
    },
  );
}
