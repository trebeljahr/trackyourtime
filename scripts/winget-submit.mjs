#!/usr/bin/env node
/*
 * Open the microsoft/winget-pkgs pull request for one published desktop
 * release, with Microsoft's own wingetcreate:
 *
 *   node scripts/winget-submit.mjs --manifests <dir> --wingetcreate <wingetcreate.exe> [--dry-run]
 *
 * <dir> is `manifests/winget` as `scripts/desktop-manifests.mjs` writes it: the
 * three files of one multi-file manifest and NOTHING else, because wingetcreate
 * deserializes every file in the directory it is handed. The checksums in them
 * were taken from the real published release files, so this script neither
 * downloads nor hashes anything — it submits what was already rendered and
 * reviewed.
 *
 * Why `submit` and not `wingetcreate update`: `update` starts from the
 * manifests winget-pkgs already holds, which a first submission has none of,
 * and it re-derives the installer entries from URLs it is given. `submit`
 * publishes exactly the manifests in this repo's `packaging/winget` templates,
 * for the first version and every one after it, so what CI opens is what a
 * reviewer read in the diff. It validates them against the manifest schema
 * first, and derives the `manifests/<partition>/<Publisher>/<Package>/<version>/`
 * path itself, which is the part a hand-copied submission gets wrong.
 *
 * Nothing here is retried or forced. A pull request is an outward-facing,
 * one-way action against somebody else's repository: a failure is reported and
 * the manifests stay in the workflow artifact for a manual submission.
 *
 * Environment:
 *   WINGET_PKGS_TOKEN   a CLASSIC personal access token with the `public_repo`
 *                       scope, and nothing else. wingetcreate refuses
 *                       fine-grained tokens, and a fine-grained token could not
 *                       open a pull request against a repository its owner does
 *                       not own anyway. Unset: this script prints a notice and
 *                       exits 0 — the all-or-none rule every other release
 *                       channel follows.
 *   GH_TOKEN            optional, only to ask winget-pkgs whether the package
 *                       is already there (which decides the pull request
 *                       title). `github.token` is enough; it is never sent
 *                       anywhere but api.github.com.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WINGET_PACKAGE_IDENTIFIER, wingetManifestPath, wingetPrTitle } from "./lib/desktop-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
}

const manifestsDir = option("--manifests");
const wingetcreate = option("--wingetcreate");
const dryRun = process.argv.includes("--dry-run");
if (!manifestsDir) fail("usage: --manifests <dir> --wingetcreate <wingetcreate.exe> [--dry-run]");
if (!wingetcreate && !dryRun) fail("--wingetcreate <path to wingetcreate.exe> is required unless --dry-run.");

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const manifestPath = wingetManifestPath(version);

// The directory must hold the manifest and only the manifest: wingetcreate
// reads every file in it, and a stray README or checksum file is a
// deserialization error in the middle of a submission.
if (!existsSync(manifestsDir) || !statSync(manifestsDir).isDirectory()) fail(`${manifestsDir} is not a directory.`);
const found = readdirSync(manifestsDir).sort();
const expected = [
  `${WINGET_PACKAGE_IDENTIFIER}.installer.yaml`,
  `${WINGET_PACKAGE_IDENTIFIER}.locale.en-US.yaml`,
  `${WINGET_PACKAGE_IDENTIFIER}.yaml`,
].sort();
if (found.join("|") !== expected.join("|")) {
  fail(`${manifestsDir} must hold exactly ${expected.join(", ")}; it holds ${found.join(", ") || "nothing"}.`);
}

// Every manifest must name this version, or the pull request would submit one
// release's installer under another release's folder.
for (const name of found) {
  const text = readFileSync(join(manifestsDir, name), "utf8");
  if (!new RegExp(`^PackageVersion:\\s*${version.replace(/\./g, "\\.")}\\s*$`, "m").test(text)) {
    fail(`${name} does not declare PackageVersion: ${version}.`);
  }
  if (!new RegExp(`^PackageIdentifier:\\s*${WINGET_PACKAGE_IDENTIFIER}\\s*$`, "m").test(text)) {
    fail(`${name} does not declare PackageIdentifier: ${WINGET_PACKAGE_IDENTIFIER}.`);
  }
  if (/-unsigned\./.test(text)) fail(`${name} points at an -unsigned installer, which no release attaches.`);
}

/** Does winget-pkgs already carry this package? Decides the pull request title only. */
async function packageExists() {
  // The package's folder, which is its version folders' parent: the path for an
  // empty version, minus the trailing slash that leaves.
  const packageDir = wingetManifestPath("").replace(/\/$/, "");
  const url = `https://api.github.com/repos/microsoft/winget-pkgs/contents/${packageDir}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "trackyourtime-winget-submit" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  try {
    const response = await fetch(url, { headers });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    console.log(`::warning::winget-pkgs answered ${response.status} for ${url}; assuming the package is new.`);
    return false;
  } catch (err) {
    console.log(`::warning::Could not ask winget-pkgs whether ${WINGET_PACKAGE_IDENTIFIER} exists (${err instanceof Error ? err.message : err}).`);
    return false;
  }
}

const token = (process.env.WINGET_PKGS_TOKEN ?? "").trim();
const exists = await packageExists();
const title = wingetPrTitle({ version, exists });

console.log(`  package:   ${WINGET_PACKAGE_IDENTIFIER} ${version} (${exists ? "a new version" : "a new package"})`);
console.log(`  path:      ${manifestPath}`);
console.log(`  manifests: ${found.join(", ")}`);
console.log(`  title:     ${title}`);

if (dryRun) {
  console.log("\n  --dry-run: nothing was submitted.");
  process.exit(0);
}
if (token === "") {
  console.log(
    "::notice::WINGET_PKGS_TOKEN is not set, so no pull request was opened. " +
      `The manifests are in this run's artifact; submit them by hand into ${manifestPath} ` +
      '(docs/deploy.md → "Windows, NSIS and winget").',
  );
  process.exit(0);
}

// The token is passed as an argument because wingetcreate reads it nowhere
// else; it is never printed, and Actions masks it in the log either way.
try {
  execFileSync(wingetcreate, ["submit", "--token", token, "--prtitle", title, "--no-open", manifestsDir], { stdio: "inherit" });
} catch {
  fail(
    "wingetcreate submit failed. Nothing was merged; the manifests are in this run's artifact. " +
      "A 403 or 404 usually means the token is not a CLASSIC token with the public_repo scope.",
  );
}
console.log(`\n  Submitted. Review the pull request against microsoft/winget-pkgs before it is merged.`);
