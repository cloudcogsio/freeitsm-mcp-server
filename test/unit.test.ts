/**
 * Unit tests: configuration, path normalisation, pagination after trimming,
 * and launching the built entry point. Run: npm test
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { normalisePath } from "../src/catalogue.js";
import { loadConfig, parseBoolean } from "../src/config.js";
import { CHARACTER_LIMIT, render, resumeAfterTrim } from "../src/format.js";

const base = { FREEITSM_URL: "https://itsm.example.com", FREEITSM_API_KEY: "fitsm_x" };

test("FREEITSM_READ_ONLY accepts only clear values and never fails open", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "on", "true "]) assert.equal(parseBoolean("X", v), true, v);
  for (const v of [undefined, "", "0", "false", "No", "off"]) assert.equal(parseBoolean("X", v), false, String(v));
  for (const v of ["ture", "readonly", "enabled", "y"]) assert.throws(() => parseBoolean("X", v), /must be true or false/, v);
  assert.throws(() => loadConfig({ ...base, FREEITSM_READ_ONLY: "ture" }), /FREEITSM_READ_ONLY/);
});

test("FREEITSM_URL is normalised and plain http to a remote host warns", () => {
  assert.equal(loadConfig({ ...base, FREEITSM_URL: "https://itsm.example.com/sub/?x=1#y" }).apiBase, "https://itsm.example.com/sub/api/v1");
  assert.equal(loadConfig({ ...base, FREEITSM_URL: "https://itsm.example.com/api/v1/" }).apiBase, "https://itsm.example.com/api/v1");
  assert.equal(loadConfig({ ...base, FREEITSM_URL: "http://localhost:8080" }).warnings.length, 0);
  assert.match(loadConfig({ ...base, FREEITSM_URL: "http://itsm.example.com" }).warnings[0], /unencrypted/);
  assert.throws(() => loadConfig({ ...base, FREEITSM_URL: "ftp://x" }), /https/);
  assert.throws(() => loadConfig({ ...base, FREEITSM_UPLOAD_DIR: join(tmpdir(), "zz-does-not-exist-123") }), /does not exist/);
});

test("normalisePath keeps the checked path and the sent path the same", () => {
  assert.equal(normalisePath("/tickets/42/"), "/tickets/42");
  assert.equal(normalisePath("api/v1/tickets/42"), "/tickets/42");
  assert.equal(normalisePath("https://h.example/itsm/api/v1/tickets?q=1"), "/tickets");
  assert.equal(normalisePath("/api/v1foo/x"), "/api/v1foo/x", "no prefix match without a segment boundary");
  assert.equal(normalisePath("/tickets/{id}", { allowTemplate: true }), "/tickets/{id}");
  for (const bad of ["/tickets/..", "/tickets/./1", "/a//b", "/tickets/%2e%2e", "/tickets/1%2F2", "/tickets\\1", "/tickets/{id}", "/x y"]) {
    assert.throws(() => normalisePath(bad), /not a plain API path/, bad);
  }
});

test("after trimming a page, the suggested next page skips nothing", () => {
  for (const [page, perPage, shown] of [[1, 100, 37], [3, 25, 12], [2, 50, 50], [7, 100, 1]]) {
    const next = resumeAfterTrim(page, perPage, shown);
    assert.equal((next.page - 1) * next.per_page, (page - 1) * perPage + shown, `${page}/${perPage}/${shown}`);
    assert.ok(next.per_page >= 1 && next.per_page <= shown);
  }
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, body: "x".repeat(2000) }));
  const out = render({ kind: "json", status: 200, data: items, meta: { page: 2, per_page: 40, total: 200, total_pages: 5 }, raw: null }, "T");
  const t = (out.content[0] as { text: string }).text;
  assert.doesNotMatch(t, /page=3\b/, "must not jump to the next page after trimming");
  assert.match(t, /page=\d+, per_page=\d+/);
  const huge = render({ kind: "json", status: 200, data: [{ body: "y".repeat(CHARACTER_LIMIT * 2) }], raw: null }, "T");
  assert.ok((huge.content[0] as { text: string }).text.length < CHARACTER_LIMIT + 500, "a single oversized item is cut too");
});

test("the built entry point starts however it is launched", () => {
  const entry = resolve("dist/index.js");
  const run = (file: string) => spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 20_000 });
  // Missing settings: it must get as far as reading them and say so, not exit silently.
  const direct = run(entry);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /Missing environment variable/);

  // Through a differently named link, as npm's bin launcher does on Linux/macOS.
  const dir = mkdtempSync(join(tmpdir(), "zz-fitsm-bin-"));
  const link = join(dir, "freeitsm-mcp-server");
  try {
    symlinkSync(entry, link);
  } catch {
    copyFileSync(entry, `${link}.mjs`); // Windows without symlink rights: still check a renamed launch
    return;
  }
  const viaLink = run(link);
  assert.equal(viaLink.status, 1);
  assert.match(viaLink.stderr, /Missing environment variable/);
});
