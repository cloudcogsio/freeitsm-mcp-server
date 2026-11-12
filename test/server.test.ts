/**
 * In-process tests: FreeITSM is replaced by a stubbed fetch that serves the
 * install's real openapi.json / spec.json (test/fixtures, refreshed with
 * `npm run fixtures`) and a /ping answer with the permissions under test.
 * Run: npm test
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { bootstrap, createServerFactory } from "../src/server.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OPENAPI = fixture("openapi.json");
const SPEC = fixture("spec.json");

type Seen = { method: string; path: string; search: string; body: unknown };
let seen: Seen[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  seen = [];
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFreeItsm(permissions: Record<string, string[]>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/openapi.json") return new Response(OPENAPI, { headers: { "content-type": "application/json" } });
    if (path === "/spec.json") return new Response(SPEC, { headers: { "content-type": "application/json" } });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer fitsm_test") return json({ error: { code: "unauthenticated", message: "Invalid API key." } }, 401);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "<form>" : undefined;
    seen.push({ method: init?.method ?? "GET", path, search: url.search, body });
    if (path === "/ping") {
      return json({ data: { ok: true, key: { name: "ZZ test", acts_as: "ZZ Analyst", permissions, companies: null, expires_at: null } } });
    }
    if (path === "/tickets") return json({ data: [{ id: 1, subject: "ZZ printer" }], meta: { page: 1, per_page: 25, total: 30, total_pages: 2 } });
    if (path === "/tickets/1") return json({ data: { id: 1, subject: "ZZ printer" } });
    if (path === "/tickets/1/notes") return json({ data: { id: 9 } }, 201);
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  }) as typeof fetch;
}

async function connect(permissions: Record<string, string[]>, extraEnv: Record<string, string> = {}) {
  stubFreeItsm(permissions);
  const deps = await bootstrap({ FREEITSM_URL: "http://freeitsm.test", FREEITSM_API_KEY: "fitsm_test", ...extraEnv });
  const server = createServerFactory(deps)();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, names, deps };
}

const textOf = (r: { content?: unknown }) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

test("a ticket-read key only gets reading tools", async () => {
  const { names } = await connect({ tickets: ["read"] });
  assert.ok(names.includes("freeitsm_search_tickets"));
  assert.ok(names.includes("freeitsm_get_ticket"));
  assert.ok(names.includes("freeitsm_api_get"));
  assert.ok(!names.includes("freeitsm_create_ticket"));
  assert.ok(!names.includes("freeitsm_api_write"), "no write permission means no write tool");
  assert.ok(!names.includes("freeitsm_reference_data"));
});

test("read-only mode hides write tools even for a full key", async () => {
  const { names } = await connect({ tickets: ["read", "create", "update"], ticket_notes: ["read", "create"] }, { FREEITSM_READ_ONLY: "true" });
  assert.ok(names.includes("freeitsm_search_tickets"));
  assert.ok(!names.includes("freeitsm_create_ticket"));
  assert.ok(!names.includes("freeitsm_add_ticket_note"));
  assert.ok(!names.includes("freeitsm_api_write"));
});

test("search_tickets passes filters and reports more pages", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const r = await client.callTool({ name: "freeitsm_search_tickets", arguments: { q: "printer", state: "open", unassigned: true } });
  assert.ok(!r.isError, textOf(r));
  assert.match(seen.at(-1)!.search, /q=printer/);
  assert.match(seen.at(-1)!.search, /unassigned=true/);
  assert.match(textOf(r), /page=2/);
});

test("get_ticket reports parts the key cannot read instead of failing", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const r = await client.callTool({ name: "freeitsm_get_ticket", arguments: { id: 1, include: ["sla"] } });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /"sla": "unavailable/);
});

test("the generic tools refuse endpoints the key lacks, without calling FreeITSM", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const before = seen.length;
  const r = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "/changes" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /changes\.read/);
  assert.equal(seen.length, before);
});

test("api_write sends a JSON body to the matched endpoint", async () => {
  const { client } = await connect({ tickets: ["read"], ticket_notes: ["create"] });
  const r = await client.callTool({
    name: "freeitsm_api_write",
    arguments: { method: "POST", path: "/api/v1/tickets/1/notes", body: { text: "ZZ hello" } },
  });
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/tickets/1/notes", search: "", body: { text: "ZZ hello" } });
});

test("list_endpoints explains what is missing", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const r = await client.callTool({ name: "freeitsm_list_endpoints", arguments: { section: "Tickets", include_unavailable: true } });
  assert.match(textOf(r), /tickets\.create/);
});

test("a bad key stops startup with a clear message", async () => {
  stubFreeItsm({});
  await assert.rejects(bootstrap({ FREEITSM_URL: "http://freeitsm.test", FREEITSM_API_KEY: "wrong" }), /rejected the API key/);
});

// ---- Hardening (pre-publication review) ----

test("dot segments cannot reach a different endpoint than the one checked", async () => {
  const { client } = await connect({ problem_links: ["delete"], tickets: ["read"] });
  const before = seen.length;
  for (const path of ["/problems/../tickets/5", "/problems/%2e%2e/tickets/5", "/tickets/1/..", "/tickets\\1"]) {
    const r = await client.callTool({ name: "freeitsm_api_write", arguments: { method: "DELETE", path } });
    assert.equal(r.isError, true, `${path} should be refused`);
    assert.match(textOf(r), /not a plain API path/);
  }
  assert.equal(seen.length, before, "nothing may be sent");
});

test("the API root and the reserved ?path= parameter are not callable", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const before = seen.length;
  const root = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "/", query: { path: "/users" } } });
  assert.equal(root.isError, true);
  const smuggled = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "/tickets", query: { path: "/users" } } });
  assert.equal(smuggled.isError, true);
  assert.match(textOf(smuggled), /not allowed/);
  const inline = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "/tickets?path=/users" } });
  assert.equal(inline.isError, true);
  assert.equal(seen.length, before, "nothing may be sent");
});

test("a sub-path install URL and inline queries are handled", async () => {
  const { client } = await connect({ tickets: ["read"] });
  const r = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "https://other.example/itsm/api/v1/tickets?q=a&q=b#x" } });
  assert.ok(!r.isError, textOf(r));
  assert.equal(seen.at(-1)!.path, "/tickets");
  assert.equal(seen.at(-1)!.search, "?q=a&q=b");
});

test("endpoints with an unknown permission are unavailable (fail closed)", async () => {
  // spec.json missing, and an OpenAPI 403 text that names no permission
  const doc = JSON.parse(OPENAPI);
  doc.paths["/tickets"].get.responses["403"].description = "Forbidden.";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    if (path === "/openapi.json") return json(doc);
    if (path === "/spec.json") return new Response("nope", { status: 404 });
    return json({ data: { ok: true, key: { name: "k", acts_as: "a", permissions: { tickets: ["read"] }, companies: null, expires_at: null } } });
  }) as typeof fetch;
  const deps = await bootstrap({ FREEITSM_URL: "http://freeitsm.test", FREEITSM_API_KEY: "fitsm_test" });
  const list = deps.catalogue.find("GET", "/tickets")!;
  assert.equal(list.permission, undefined);
  assert.equal(deps.access.allows(list), false);
  assert.equal(deps.access.allows(deps.catalogue.find("GET", "/tickets/{id}")), true, "the 403 text still gives other permissions");
  assert.ok(deps.catalogue.warnings.some((w) => /spec\.json/.test(w)));
  assert.ok(deps.catalogue.warnings.some((w) => /no known permission/.test(w)));
});

test("an endpoint that needs a second permission is unavailable without it", async () => {
  const content = "/projects/{id}/documents/{document_id}/content";
  const without = await connect({ projects: ["read"] });
  const ep = without.deps.catalogue.find("GET", content)!;
  assert.deepEqual(ep.extraPermissions, ["documents.download"]);
  const before = seen.length;
  const r = await without.client.callTool({ name: "freeitsm_api_get", arguments: { path: "/projects/4/documents/7/content" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /documents\.download/);
  assert.equal(seen.length, before, "a call FreeITSM would refuse is not sent");
  const withIt = await connect({ projects: ["read"], documents: ["download"] });
  assert.equal(withIt.deps.access.allows(withIt.deps.catalogue.find("GET", content)), true);
});

test("project documents: a link goes as JSON, a file as multipart", async () => {
  const { client, names } = await connect({ projects: ["read", "update"] });
  assert.ok(names.includes("freeitsm_add_project_document"));
  assert.ok(names.includes("freeitsm_api_write"), "JSON is allowed on an endpoint that also takes files");
  const add = (args: Record<string, unknown>) => client.callTool({ name: "freeitsm_add_project_document", arguments: { project_id: 4, ...args } });
  await add({ external_url: "https://example.com/zz.pdf", title: "ZZ design" });
  assert.deepEqual(seen.at(-1), {
    method: "POST",
    path: "/projects/4/documents",
    search: "",
    body: { external_url: "https://example.com/zz.pdf", title: "ZZ design" },
  });
  await add({ content_base64: Buffer.from("zz").toString("base64"), filename: "zz.txt" });
  assert.equal(seen.at(-1)!.body, "<form>");
  const before = seen.length;
  assert.match(textOf(await add({ external_url: "https://example.com/a", content_base64: "eno=", filename: "a" })), /not both/);
  assert.match(textOf(await add({})), /Give a file/);
  assert.equal(seen.length, before);
});

test("upload-only endpoints are still refused by api_write", async () => {
  const { client } = await connect({ change_attachments: ["create"], ticket_notes: ["create"] });
  const r = await client.callTool({ name: "freeitsm_api_write", arguments: { method: "POST", path: "/changes/3/attachments", body: {} } });
  assert.match(textOf(r), /multipart file upload/);
});

test("local-file uploads: off by default, confined to FREEITSM_UPLOAD_DIR when on", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const perms = { change_attachments: ["create"] };

  const off = await connect(perms);
  const schema = (await off.client.listTools()).tools.find((t) => t.name === "freeitsm_upload_change_evidence")!.inputSchema;
  assert.ok(!("file_path" in (schema.properties ?? {})), "no file_path without FREEITSM_UPLOAD_DIR");

  const root = mkdtempSync(join(tmpdir(), "zz-fitsm-"));
  const dir = join(root, "uploads");
  mkdirSync(dir);
  writeFileSync(join(dir, "ok.txt"), "evidence");
  writeFileSync(join(root, "secret.txt"), "secret");
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024));

  const on = await connect(perms, { FREEITSM_UPLOAD_DIR: dir, FREEITSM_UPLOAD_MAX_MB: "1" });
  const call = (args: Record<string, unknown>) => on.client.callTool({ name: "freeitsm_upload_change_evidence", arguments: { change_id: 3, ...args } });
  for (const file_path of [join(root, "secret.txt"), "../secret.txt", join(dir, "..", "secret.txt")]) {
    const r = await call({ file_path });
    assert.equal(r.isError, true, `${file_path} must be refused`);
    assert.match(textOf(r), /only files inside/);
  }
  assert.match(textOf(await call({ file_path: "big.bin" })), /upload limit/);
  assert.match(textOf(await call({ content_base64: Buffer.alloc(1100 * 1024).toString("base64"), filename: "x.bin" })), /upload limit/);
  const before = seen.length;
  await call({ file_path: "ok.txt" }); // reaches the (stubbed) API
  assert.equal(seen.length, before + 1);
  assert.deepEqual(seen.at(-1)!.path, "/changes/3/attachments");
});
