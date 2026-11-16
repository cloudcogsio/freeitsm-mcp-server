/**
 * Build the Docker image with current base images.
 *
 * The Dockerfile pins every base image by digest, so a plain `docker build` never
 * picks up the security updates published for those bases. This script:
 *   1. looks up the digest each pinned tag points to now and updates the Dockerfile,
 *   2. checks the production dependencies with `npm audit`,
 *   3. builds freeitsm-mcp-server:local and :<version>-local,
 *   4. scans the image with grype (as CI does), run from its own pinned image,
 *      and reports when a newer grype release exists.
 *
 * Local builds are for testing. The MCP clients run :latest, which only
 * `npm run image:update` sets: the published image, once its attestation checks out.
 *
 * Run: npm run docker:build             (update the bases, then build)
 *      npm run docker:build -- --check  (only report; exits 1 if a base or the scanner has an update)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Scanner image, pinned like the bases; bump the version and digest together. */
const GRYPE_IMAGE = "anchore/grype:v0.121.3@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887";
const GRYPE_DB_VOLUME = "freeitsm-grype-db";

const checkOnly = process.argv.includes("--check");
const DOCKERFILE = "Dockerfile";
const FROM = /^(FROM\s+)(\S+?)@(sha256:[0-9a-f]{64})/gm;

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function currentDigest(ref: string): string {
  const out = run("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest.Digest}}"]);
  const digest = JSON.parse(out) as string;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Unexpected digest for ${ref}: ${out}`);
  return digest;
}

// 1. Base images
const source = readFileSync(DOCKERFILE, "utf8");
const latest = new Map<string, string>();
for (const [, , ref] of source.matchAll(FROM)) if (!latest.has(ref)) latest.set(ref, currentDigest(ref));

const stale: string[] = [];
const updated = source.replace(FROM, (line, from: string, ref: string, digest: string) => {
  const now = latest.get(ref)!;
  if (now === digest) return line;
  stale.push(`${ref}: ${digest.slice(7, 19)} -> ${now.slice(7, 19)}`);
  return `${from}${ref}@${now}`;
});
const unique = [...new Set(stale)];
console.error(unique.length ? `base images with updates:\n  ${unique.join("\n  ")}` : "base images are current");

// The scanner is pinned too, and Dependabot does not look inside this script.
const scannerUpdate = await newerGrype();
if (scannerUpdate) console.error(`scanner update: ${scannerUpdate}`);

if (checkOnly) process.exit(unique.length || scannerUpdate ? 1 : 0);
if (unique.length) {
  writeFileSync(DOCKERFILE, updated);
  console.error("Dockerfile updated (commit it with the release)");
}

/** "grype v0.121.3 -> v0.122.0; set GRYPE_IMAGE ..." or null when the pin is current. */
async function newerGrype(): Promise<string | null> {
  const pinned = /:(v[\d.]+)@/.exec(GRYPE_IMAGE)![1];
  try {
    const res = await fetch("https://api.github.com/repos/anchore/grype/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "freeitsm-mcp-server-build" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tag = String(((await res.json()) as { tag_name?: unknown }).tag_name ?? "");
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`unexpected tag "${tag}"`);
    if (tag === pinned) return null;
    return `grype ${pinned} -> ${tag}; set GRYPE_IMAGE in scripts/docker-build.ts to anchore/grype:${tag}@${currentDigest(`anchore/grype:${tag}`)}`;
  } catch (e) {
    console.error(`could not check for a newer grype (${(e as Error).message})`);
    return null;
  }
}

// 2. Production dependencies (npm is a .cmd on Windows, which needs a shell; the arguments are fixed)
const audit = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high"], { stdio: "inherit", shell: process.platform === "win32" });
if (audit.status !== 0) {
  console.error("npm audit found high or critical issues in production dependencies; fix them (npm update / npm audit fix) and run again.");
  process.exit(1);
}

// 3. Build
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const image = "freeitsm-mcp-server";
// Not :latest - the MCP clients run that, and only `npm run image:update` sets it (verified published image).
const tags = [`${image}:local`, `${image}:${version}-local`];
execFileSync("docker", ["build", ...tags.flatMap((t) => ["-t", t]), "."], { stdio: "inherit" });
console.error(`built ${tags.join(" and ")}`);

// 4. Scan with grype (the scanner CI uses), from its own pinned image. The image is handed over
// as a `docker save` archive on a read-only mount, so the scanner gets no Docker socket.
// Its vulnerability database is kept in a named volume between runs.
const dir = mkdtempSync(join(tmpdir(), "freeitsm-scan-"));
const archive = join(dir, "image.tar");
try {
  execFileSync("docker", ["save", "-o", archive, tags[0]], { stdio: "inherit" });
  const scan = spawnSync(
    "docker",
    [
      "run", "--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--mount", `type=bind,source=${dir},target=/scan,readonly`,
      "--mount", `type=volume,source=${GRYPE_DB_VOLUME},target=/grype-db`,
      "-e", "GRYPE_DB_CACHE_DIR=/grype-db",
      GRYPE_IMAGE,
      "docker-archive:/scan/image.tar", "--only-fixed", "--fail-on", "high",
    ],
    { stdio: "inherit" },
  );
  if (scan.error) {
    console.error(`The image was not scanned: ${scan.error.message}. CI scans it as well.`);
  } else if (scan.status !== 0) {
    console.error("WARNING: the image has fixable high or critical vulnerabilities, or the scan failed (see above).");
    process.exitCode = 2;
  } else {
    console.error("scan: no fixable high or critical vulnerabilities");
  }
} finally {
  rmSync(archive, { force: true });
  rmdirSync(dir);
}
