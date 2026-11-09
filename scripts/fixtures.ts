/**
 * Refresh test/fixtures from a FreeITSM install (public documents, no key needed).
 * Run: npm run fixtures            (uses FREEITSM_URL from .env, or http://localhost:8080)
 */
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env.FREEITSM_URL ?? "http://localhost:8080").replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";

for (const name of ["openapi.json", "spec.json"]) {
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(`test/fixtures/${name}`, await res.text());
  console.error(`saved test/fixtures/${name}`);
}
