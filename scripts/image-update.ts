/**
 * Update the local image the MCP clients run (freeitsm-mcp-server:latest) to the
 * published one, only after checking where it came from.
 *
 *   1. looks up the digest ghcr.io/cloudcogsio/freeitsm-mcp-server:<tag> points to,
 *   2. verifies its build provenance attestation with the GitHub CLI: built by this
 *      repository's "Publish image" workflow (needs `gh auth login`),
 *   3. pulls exactly that digest and tags it freeitsm-mcp-server:latest.
 *
 * The client configurations keep using freeitsm-mcp-server:latest; restart the
 * clients afterwards.
 *
 * Run: npm run image:update                 (the :latest published from main)
 *      npm run image:update -- --tag 0.4.1  (a release)
 *      npm run image:update -- --check      (only report whether an update exists; exits 1 if so)
 */
import { execFileSync, spawnSync } from "node:child_process";

const REPO = "cloudcogsio/freeitsm-mcp-server";
const REMOTE = `ghcr.io/${REPO}`;
const LOCAL = "freeitsm-mcp-server:latest";
const WORKFLOW = `${REPO}/.github/workflows/release.yml`;

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : "latest";
if (!tag || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new Error(`Not a valid tag: ${tag}`);

function run(cmd: string, cmdArgs: string[]): string {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

// 1. What the tag points to now
const digest = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", `${REMOTE}:${tag}`, "--format", "{{json .Manifest.Digest}}"])) as string;
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Unexpected digest: ${digest}`);
const pinned = `${REMOTE}@${digest}`;
console.error(`${REMOTE}:${tag} is ${digest}`);

const local = spawnSync("docker", ["image", "inspect", LOCAL, "--format", "{{json .RepoDigests}}"], { encoding: "utf8" });
const localDigests = local.status === 0 ? (JSON.parse(local.stdout) as string[]) : [];
if (localDigests.includes(pinned)) {
  console.error(`${LOCAL} is already this image; nothing to do.`);
  process.exit(0);
}
console.error(`${LOCAL} is ${localDigests.find((d) => d.startsWith(`${REMOTE}@`)) ?? "a local build or missing"}`);
if (checkOnly) process.exit(1);

// 2. Where it came from
const verify = spawnSync("gh", ["attestation", "verify", `oci://${pinned}`, "--repo", REPO, "--signer-workflow", WORKFLOW], { stdio: "inherit" });
if (verify.status !== 0) {
  console.error(`The attestation for ${pinned} could not be verified; ${LOCAL} was not changed.`);
  process.exit(1);
}

// 3. Pull exactly what was verified
execFileSync("docker", ["pull", pinned], { stdio: "inherit" });
execFileSync("docker", ["tag", pinned, LOCAL], { stdio: "inherit" });
console.error(`${LOCAL} is now ${pinned}. Restart your MCP clients (or reconnect the server) to use it.`);
