/**
 * Smoke test against a real FreeITSM: starts the built server over stdio with the
 * settings in .env (or the environment), lists its tools and makes read-only calls.
 * Run: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = Object.fromEntries(
  // NODE_EXTRA_CA_CERTS too, so an install with a private CA works
  Object.entries(process.env).filter(([k]) => k.startsWith("FREEITSM_") || k === "NODE_EXTRA_CA_CERTS"),
) as Record<string, string>;
if (!env.FREEITSM_URL || !env.FREEITSM_API_KEY) {
  console.error("Set FREEITSM_URL and FREEITSM_API_KEY (see .env.example).");
  process.exit(2);
}

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment(), ...env }, stderr: "inherit" }),
);
const textOf = (r: { content?: unknown }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

const { tools } = await client.listTools();
console.error(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
for (const t of ["freeitsm_whoami", "freeitsm_list_endpoints", "freeitsm_describe_endpoint", "freeitsm_api_get"]) {
  assert.ok(tools.some((x) => x.name === t), `missing ${t}`);
}

const who = await client.callTool({ name: "freeitsm_whoami", arguments: {} });
assert.ok(!who.isError, textOf(who));
console.error(`whoami ok`);

const sections = await client.callTool({ name: "freeitsm_list_endpoints", arguments: {} });
assert.ok(!sections.isError, textOf(sections));
console.error(textOf(sections).split("\n")[0]);

if (tools.some((t) => t.name === "freeitsm_search_tickets")) {
  const r = await client.callTool({ name: "freeitsm_search_tickets", arguments: { per_page: 3 } });
  assert.ok(!r.isError, textOf(r));
  console.error(`search_tickets ok (${textOf(r).length} chars)`);
}
if (tools.some((t) => t.name === "freeitsm_reference_data")) {
  const r = await client.callTool({ name: "freeitsm_reference_data", arguments: { list: "statuses" } });
  assert.ok(!r.isError, textOf(r));
  console.error("reference_data ok");
}

const bad = await client.callTool({ name: "freeitsm_api_get", arguments: { path: "/no-such-thing" } });
assert.equal(bad.isError, true, "an unknown path must be a tool error");

await client.close();
console.error("Smoke test passed");
