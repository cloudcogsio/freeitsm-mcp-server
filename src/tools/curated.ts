/**
 * Dedicated tools for the jobs an assistant does most. Each one is registered
 * only when the key may call the endpoint behind it, so a narrow key gives a
 * short tool list. Anything else goes through the generic tools.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { HttpMethod, Query } from "../api.js";
import { call, permitted, type Deps } from "../context.js";
import { render, text } from "../format.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const id = (what: string) => z.number().int().positive().describe(`${what} id`);
const page = {
  page: z.number().int().min(1).default(1).describe("Page number, from 1"),
  per_page: z.number().int().min(1).max(100).default(25).describe("Results per page (max 100)"),
};
const state = z.enum(["open", "closed", "all"]).optional().describe("Open, closed or all (default all)");
const isoDate = (what: string) => z.string().optional().describe(`${what}, ISO 8601 e.g. 2026-11-01T00:00:00Z`);

/**
 * The real path of a file the upload tool may read: it must exist inside the
 * configured upload folder after resolving symlinks, and be within the size limit.
 */
export async function resolveUploadFile(uploadDir: string | null, filePath: string, maxBytes: number): Promise<string> {
  if (!uploadDir) throw new Error("Uploading local files is switched off (FREEITSM_UPLOAD_DIR is not set). Send content_base64 instead.");
  let real: string;
  try {
    real = await realpath(isAbsolute(filePath) ? filePath : resolve(uploadDir, filePath));
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  const rel = relative(uploadDir, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to upload ${filePath}: only files inside ${uploadDir} may be uploaded.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
  if (info.size > maxBytes) throw new Error(`${filePath} is larger than the ${+(maxBytes / 1024 / 1024).toFixed(1)} MB upload limit.`);
  return real;
}

/** Drop undefined so only the fields the model set are sent (PATCH semantics). */
function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function registerCuratedTools(server: McpServer, deps: Deps): void {
  const can = (method: HttpMethod, template: string) => !!permitted(deps, method, template);

  // ---------------------------------------------------------------- whoami
  server.registerTool(
    "freeitsm_whoami",
    {
      title: "Who am I / what may I do",
      description:
        "Show the API key this server uses: the analyst it acts as, its companies, expiry and permissions, and whether the server runs read-only. Use it to explain why something is not allowed.",
      annotations: READ,
    },
    async (ctx) => {
      const res = await deps.client.request("GET", "/ping", { signal: ctx.mcpReq.signal });
      const data = res.kind === "json" ? res.data : null;
      const note = deps.access.readOnly ? "\n\nThis MCP server runs read-only: write tools are hidden whatever the key allows." : "";
      return text(`${JSON.stringify(data, null, 1)}${note}`);
    },
  );

  // ---------------------------------------------------------------- tickets
  if (can("GET", "/tickets")) {
    server.registerTool(
      "freeitsm_search_tickets",
      {
        title: "Search tickets",
        description: `List or search tickets (incidents and requests) the key can see, newest first by default.
Use freeitsm_get_ticket for one ticket's full detail.

Examples:
  - "my open printer tickets" -> q="printer", state="open"
  - "unassigned high-priority tickets" -> state="open", priority="High", unassigned=true
  - "what changed since yesterday" -> updated_since="2026-11-08T00:00:00Z", sort="-updated_at"`,
        inputSchema: z.strictObject({
          q: z.string().optional().describe("Search in subject and ticket number"),
          state,
          status: z.string().optional().describe('Status name, e.g. "In Progress"'),
          priority: z.string().optional().describe('Priority name, e.g. "High"'),
          assigned_analyst_id: z.number().int().optional().describe("Assignee analyst id"),
          unassigned: z.boolean().optional().describe("true = only unassigned tickets"),
          requester_email: z.string().optional().describe("Requester's email"),
          company_id: z.number().int().optional().describe("One company (must be in the key's scope)"),
          created_since: isoDate("Created on or after"),
          updated_since: isoDate("Updated on or after"),
          sort: z
            .string()
            .optional()
            .describe("created_at, updated_at, closed_at, id, subject, ticket_number, priority, status; prefix '-' for descending (default -created_at)"),
          ...page,
        }),
        annotations: READ,
      },
      async (args, ctx) => {
        const res = await call(deps, "GET", "/tickets", { query: args as Query, signal: ctx.mcpReq.signal });
        return render(res, "Tickets");
      },
    );
  }

  if (can("GET", "/tickets/{id}")) {
    const extras = {
      notes: "/tickets/{id}/notes",
      thread: "/tickets/{id}/thread",
      sla: "/tickets/{id}/sla",
      time_entries: "/tickets/{id}/time-entries",
      audit: "/tickets/{id}/audit",
    } as const;
    type Extra = keyof typeof extras;
    server.registerTool(
      "freeitsm_get_ticket",
      {
        title: "Get a ticket",
        description: `Get one ticket's full detail, optionally with its notes, email thread, SLA state, time entries and audit history in the same call.
Parts the key may not read are reported as unavailable rather than failing the whole call.`,
        inputSchema: z.strictObject({
          id: id("Ticket"),
          include: z
            .array(z.enum(Object.keys(extras) as [Extra, ...Extra[]]))
            .default([])
            .describe("Extra parts to fetch: notes, thread, sla, time_entries, audit"),
        }),
        annotations: READ,
      },
      async ({ id: ticketId, include }, ctx) => {
        const signal = ctx.mcpReq.signal;
        const base = await call(deps, "GET", `/tickets/${ticketId}`, { signal });
        const result: Record<string, unknown> = { ticket: base.kind === "json" ? base.data : null };
        await Promise.all(
          [...new Set(include)].map(async (part) => {
            const template = extras[part];
            if (!can("GET", template)) {
              result[part] = "unavailable: this key may not read it";
              return;
            }
            try {
              const res = await call(deps, "GET", template.replace("{id}", String(ticketId)), { query: { per_page: 100 }, signal });
              result[part] = res.kind === "json" ? res.data : null;
            } catch (e) {
              result[part] = `unavailable: ${(e as Error).message}`;
            }
          }),
        );
        return render({ kind: "json", status: 200, data: result, raw: result }, `Ticket ${ticketId}`);
      },
    );
  }

  if (can("POST", "/tickets")) {
    server.registerTool(
      "freeitsm_create_ticket",
      {
        title: "Create a ticket",
        description: `Log a new ticket exactly as the UI does: the requester is found or created by email, the description becomes the first message, and workflows fire.
Defaults: status Open, priority Normal, unassigned, the key's default company. Look up names/ids with freeitsm_reference_data.
Not idempotent: calling twice creates two tickets.`,
        inputSchema: z.strictObject({
          subject: z.string().min(1).describe("Ticket subject"),
          requester_email: z.string().min(3).describe("Requester's email; a new requester is created if unknown"),
          requester_name: z.string().optional().describe("Requester's display name, used if they are new"),
          description: z.string().optional().describe("The request text (plain text)"),
          priority: z.string().optional().describe('Priority name, e.g. "High"'),
          status: z.string().optional().describe('Status name, e.g. "Open"'),
          ticket_type_id: z.number().int().optional(),
          origin_id: z.number().int().optional(),
          department_id: z.number().int().optional(),
          assigned_analyst_id: z.number().int().optional().describe("Assign on creation"),
          company_id: z.number().int().optional().describe("Company to file it under (must be in the key's scope)"),
          custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom field values by key"),
        }),
        annotations: CREATE,
      },
      async (args, ctx) => {
        const res = await call(deps, "POST", "/tickets", { body: defined(args), signal: ctx.mcpReq.signal });
        return render(res, "Created ticket");
      },
    );
  }

  if (can("PATCH", "/tickets/{id}")) {
    server.registerTool(
      "freeitsm_update_ticket",
      {
        title: "Update a ticket",
        description: `Change a ticket's fields - status, priority, assignment, classification, company, subject. Send only what should change; null clears a field.
Behaves like the UI: closing sends the closure email (and may trigger a satisfaction survey), assigning sends the assignment email, and everything is audited.
To add a comment use freeitsm_add_ticket_note instead.`,
        inputSchema: z.strictObject({
          id: id("Ticket"),
          subject: z.string().min(1).optional(),
          status: z.string().optional().describe('Status name, e.g. "Closed"'),
          priority: z.string().nullable().optional().describe("Priority name; null clears"),
          assigned_analyst_id: z.number().int().nullable().optional().describe("Analyst id; null unassigns"),
          ticket_type_id: z.number().int().nullable().optional(),
          origin_id: z.number().int().nullable().optional(),
          department_id: z.number().int().nullable().optional(),
          company_id: z.number().int().optional().describe("Move to another company (the key must reach both)"),
          work_start_at: z.string().nullable().optional().describe("Scheduled work start, ISO 8601; null clears"),
          sensitivity: z.enum(["normal", "confidential"]).optional(),
          first_time_fix: z.boolean().optional(),
          it_training_provided: z.boolean().optional(),
        }),
        annotations: UPDATE,
      },
      async ({ id: ticketId, ...fields }, ctx) => {
        const body = defined(fields);
        if (!Object.keys(body).length) return text("Nothing to change: give at least one field.");
        const res = await call(deps, "PATCH", `/tickets/${ticketId}`, { body, signal: ctx.mcpReq.signal });
        return render(res, `Updated ticket ${ticketId}`);
      },
    );
  }

  if (can("POST", "/tickets/{id}/notes")) {
    server.registerTool(
      "freeitsm_add_ticket_note",
      {
        title: "Add a ticket note",
        description: `Add a note to a ticket, attributed to the key's analyst. Notes are internal (analysts only) by default.
is_internal=false makes the note visible to the requester - only do that when the user asked for a public reply.`,
        inputSchema: z.strictObject({
          id: id("Ticket"),
          text: z.string().min(1).describe("The note text"),
          is_internal: z.boolean().default(true).describe("true = analysts only (default); false = visible to the requester"),
        }),
        annotations: CREATE,
      },
      async ({ id: ticketId, text: noteText, is_internal }, ctx) => {
        const res = await call(deps, "POST", `/tickets/${ticketId}/notes`, {
          body: { text: noteText, is_internal },
          signal: ctx.mcpReq.signal,
        });
        return render(res, `Note added to ticket ${ticketId}`);
      },
    );
  }

  if (can("POST", "/tickets/{id}/time-entries")) {
    server.registerTool(
      "freeitsm_log_time",
      {
        title: "Log time on a ticket",
        description: "Log minutes worked on a ticket, attributed to the key's analyst. Not idempotent: each call adds an entry.",
        inputSchema: z.strictObject({
          id: id("Ticket"),
          minutes: z.number().int().positive().describe("Minutes spent"),
          notes: z.string().optional().describe("What the time was spent on"),
          entry_at: isoDate("When the work happened (default now)"),
        }),
        annotations: CREATE,
      },
      async ({ id: ticketId, ...fields }, ctx) => {
        const res = await call(deps, "POST", `/tickets/${ticketId}/time-entries`, { body: defined(fields), signal: ctx.mcpReq.signal });
        return render(res, `Time logged on ticket ${ticketId}`);
      },
    );
  }

  // ---------------------------------------------------------------- knowledge
  if (can("GET", "/knowledge/articles")) {
    server.registerTool(
      "freeitsm_search_knowledge",
      {
        title: "Search the knowledge base",
        description: `Search knowledge-base articles by keyword or tag. Use it before answering how-to questions or resolving a ticket. freeitsm_get_article returns the full body.`,
        inputSchema: z.strictObject({
          q: z.string().optional().describe("Keywords searched in title and body"),
          tag: z.string().optional().describe("Only articles with this exact tag"),
          review: z.enum(["overdue", "upcoming", "none"]).optional().describe("Review-cycle filter"),
          sort: z.string().optional().describe("modified_at (default), created_at, title, view_count, next_review_date, id; '-' prefix for descending"),
          ...page,
        }),
        annotations: READ,
      },
      async (args, ctx) => {
        const res = await call(deps, "GET", "/knowledge/articles", { query: args as Query, signal: ctx.mcpReq.signal });
        return render(res, "Articles");
      },
    );
  }

  if (can("GET", "/knowledge/articles/{id}")) {
    server.registerTool(
      "freeitsm_get_article",
      {
        title: "Get a knowledge article",
        description: "Get one knowledge-base article in full.",
        inputSchema: z.strictObject({ id: id("Article") }),
        annotations: READ,
      },
      async ({ id: articleId }, ctx) => render(await call(deps, "GET", `/knowledge/articles/${articleId}`, { signal: ctx.mcpReq.signal }), `Article ${articleId}`),
    );
  }

  // ---------------------------------------------------------------- changes
  if (can("GET", "/changes")) {
    server.registerTool(
      "freeitsm_search_changes",
      {
        title: "Search changes",
        description: `List or search change requests. "CHG-0042" in q finds a change by reference.

Examples:
  - "changes scheduled this week" -> work_start_from="2026-11-09T00:00:00Z", work_start_to="2026-11-16T00:00:00Z"
  - "open emergency changes" -> state="open", change_type="Emergency"`,
        inputSchema: z.strictObject({
          q: z.string().optional().describe('Search title, or a reference like "CHG-0042"'),
          state,
          status: z.string().optional().describe('Status name, e.g. "Pending Approval"'),
          change_type: z.string().optional().describe("Standard, Normal or Emergency"),
          priority: z.string().optional(),
          risk_level: z.string().optional().describe("e.g. Low, Medium, High, Very High, Critical"),
          cab_required: z.boolean().optional(),
          work_start_from: isoDate("Scheduled work starts on or after"),
          work_start_to: isoDate("Scheduled work starts on or before"),
          sort: z.string().optional().describe("created_at, modified_at, id, title, work_start_at, risk_score, priority, status; '-' prefix for descending"),
          ...page,
        }),
        annotations: READ,
      },
      async (args, ctx) => render(await call(deps, "GET", "/changes", { query: args as Query, signal: ctx.mcpReq.signal }), "Changes"),
    );
  }

  if (can("GET", "/changes/{id}")) {
    server.registerTool(
      "freeitsm_get_change",
      {
        title: "Get a change",
        description: "Get one change in full: plans, risk evaluation, schedule, approval round, attachments list and linked problems.",
        inputSchema: z.strictObject({ id: id("Change") }),
        annotations: READ,
      },
      async ({ id: changeId }, ctx) => render(await call(deps, "GET", `/changes/${changeId}`, { signal: ctx.mcpReq.signal }), `Change ${changeId}`),
    );
  }

  if (can("POST", "/changes/{id}/attachments")) {
    const { uploadDir, uploadMaxBytes } = deps.config;
    const maxMb = +(uploadMaxBytes / 1024 / 1024).toFixed(1);
    server.registerTool(
      "freeitsm_upload_change_evidence",
      {
        title: "Upload change evidence",
        description: `Attach an evidence file to a change (test results, screenshots, sign-off), at most ${maxMb} MB.
${
  uploadDir
    ? `Give either file_path (a file inside ${uploadDir}; nothing outside that folder can be read) or content_base64 with filename.`
    : "Give content_base64 with filename. (Uploading local files is switched off: FREEITSM_UPLOAD_DIR is not set.)"
}
Only upload what the user asked for. Does not change the change's status or approval. Retrying with the same client_reference and identical file is safe.`,
        inputSchema: z.strictObject({
          change_id: id("Change"),
          ...(uploadDir ? { file_path: z.string().optional().describe(`Path of a file inside ${uploadDir}`) } : {}),
          content_base64: z.string().optional().describe("File content, base64 encoded"),
          filename: z.string().optional().describe("File name; required with content_base64"),
          client_reference: z
            .string()
            .regex(/^[A-Za-z0-9._:-]{1,128}$/)
            .optional()
            .describe("Your own reference, so a retry does not upload twice"),
        }),
        annotations: CREATE,
      },
      async (args, ctx) => {
        const { change_id, content_base64, filename, client_reference } = args;
        const file_path = (args as { file_path?: string }).file_path;
        let bytes: Uint8Array;
        let name: string;
        if (file_path) {
          const file = await resolveUploadFile(uploadDir, file_path, uploadMaxBytes);
          bytes = await readFile(file);
          name = filename ?? basename(file);
        } else if (content_base64 && filename) {
          if (content_base64.length > Math.ceil(uploadMaxBytes / 3) * 4 + 4) {
            return text(`The file is larger than the ${maxMb} MB upload limit.`);
          }
          bytes = Buffer.from(content_base64, "base64");
          name = filename;
        } else {
          return text(uploadDir ? "Give file_path, or content_base64 together with filename." : "Give content_base64 together with filename.");
        }
        if (bytes.byteLength > uploadMaxBytes) return text(`The file is larger than the ${maxMb} MB upload limit.`);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)]), name);
        if (client_reference) form.append("client_reference", client_reference);
        const res = await call(deps, "POST", `/changes/${change_id}/attachments`, { form, signal: ctx.mcpReq.signal });
        return render(res, `Evidence uploaded to change ${change_id} (HTTP ${res.status})`);
      },
    );
  }

  // ---------------------------------------------------------------- problems & assets
  if (can("GET", "/problems")) {
    server.registerTool(
      "freeitsm_search_problems",
      {
        title: "Search problems",
        description: 'List or search problems, including the known-error database (is_known_error=true). "PRB-0007" in q finds one by reference.',
        inputSchema: z.strictObject({
          q: z.string().optional().describe("Search title and problem number"),
          state,
          status: z.string().optional(),
          priority: z.string().optional(),
          is_known_error: z.boolean().optional().describe("true = known errors only"),
          assigned_analyst_id: z.number().int().optional(),
          sort: z.string().optional().describe("created_at, updated_at, closed_at, id, title, problem_number, priority, status; '-' prefix for descending"),
          ...page,
        }),
        annotations: READ,
      },
      async (args, ctx) => render(await call(deps, "GET", "/problems", { query: args as Query, signal: ctx.mcpReq.signal }), "Problems"),
    );
  }

  if (can("GET", "/assets")) {
    server.registerTool(
      "freeitsm_search_assets",
      {
        title: "Search assets",
        description: `Search hardware assets by hostname, service tag, model or manufacturer, or by who they are assigned to.

Examples:
  - "find laptop LT-0042" -> q="LT-0042"
  - "warranties expiring in 60 days" -> warranty_within_days=60`,
        inputSchema: z.strictObject({
          q: z.string().optional().describe("Search hostname, service tag, model and manufacturer"),
          hostname: z.string().optional().describe("Exact hostname"),
          service_tag: z.string().optional().describe("Exact service tag"),
          assigned_user_id: z.number().int().optional().describe("Assets assigned to this requester"),
          warranty_within_days: z.number().int().positive().optional(),
          warranty_expired: z.boolean().optional(),
          not_seen_days: z.number().int().positive().optional().describe("Not reported by the inventory agent for N days"),
          retired: z.enum(["exclude", "include", "only"]).optional().describe("Retired assets: exclude (default), include or only"),
          sort: z.string().optional().describe("hostname, id, first_seen, last_seen, warranty_expiry, purchase_date, model; '-' prefix for descending"),
          ...page,
        }),
        annotations: READ,
      },
      async (args, ctx) => render(await call(deps, "GET", "/assets", { query: args as Query, signal: ctx.mcpReq.signal }), "Assets"),
    );
  }

  // ---------------------------------------------------------------- reference data
  const lists = deps.catalogue.endpoints
    .filter((e) => e.method === "GET" && e.permission === "reference.read" && !e.path.includes("{") && deps.access.allows(e))
    .map((e) => ({ name: e.path.slice(1), summary: e.summary }));
  if (lists.length) {
    const names = lists.map((l) => l.name) as [string, ...string[]];
    server.registerTool(
      "freeitsm_reference_data",
      {
        title: "Look up reference data",
        description: `Get a lookup list - the valid names and ids for statuses, priorities, types, categories and so on - before creating or updating records.
Available lists:\n${lists.map((l) => `  - ${l.name}: ${l.summary}`).join("\n")}`,
        inputSchema: z.strictObject({ list: z.enum(names).describe("Which list") }),
        annotations: READ,
      },
      async ({ list }, ctx) => render(await call(deps, "GET", `/${list}`, { query: { per_page: 100 }, signal: ctx.mcpReq.signal }), list),
    );
  }
}
