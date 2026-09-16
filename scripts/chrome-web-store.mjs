#!/usr/bin/env node
/**
 * Package and publish the browser extension to the Chrome Web Store.
 * Run by `.github/workflows/extension-release.yml`; docs/releasing.md has the
 * one-time setup.
 *
 *   node scripts/chrome-web-store.mjs package --tag vX.Y.Z --out <zip> [--dir packages/extension/dist-prod]
 *   node scripts/chrome-web-store.mjs publish --tag vX.Y.Z --zip <zip> [--upload-only] [--deploy-percentage N] [--staged]
 *
 * `package` checks the built manifest's version against the tag, removes the
 * `key` field (after checking it pins the store item) and zips the directory
 * CONTENTS, manifest at the root. It refuses a package holding a private key.
 *
 * `publish` needs CWS_SERVICE_ACCOUNT_JSON and CWS_PUBLISHER_ID. It uploads,
 * polls fetchStatus until the upload is processed, submits for review unless
 * `--upload-only`, and prints the item status at the end. CWS_ITEM_ID
 * overrides the item, which otherwise is STORE_EXTENSION_ID from
 * packages/shared/src/store-clients.ts.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  containsPrivateKey,
  createStoreClient,
  describeItemStatus,
  exchangeServiceAccountToken,
  forbiddenPackagePaths,
  manifestForUpload,
  manifestVersionProblems,
  parseReleaseTag,
  parseServiceAccount,
  publishRequest,
  readStoreExtensionId,
  submit,
  uploadAndWait,
} from "./lib/chrome-web-store.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

const fail = (message) => {
  // `::error::` shows on the run summary; the plain line keeps local runs readable.
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`);
  process.exit(1);
};

const itemId = () =>
  process.env.CWS_ITEM_ID?.trim() ||
  readStoreExtensionId(join(repoRoot, "packages/shared/src/store-clients.ts"));

const listFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();

const packageCommand = (values) => {
  const dir = resolve(values.dir ?? join(repoRoot, "packages/extension/dist-prod"));
  if (!values.tag) fail("package needs --tag vX.Y.Z");
  if (!values.out) fail("package needs --out <zip>");

  const manifestPath = join(dir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}. Run pnpm run build:extension:prod first.`);
  }

  const problems = manifestVersionProblems(manifest, values.tag);
  if (problems.length > 0) fail(problems.join(" "));

  const staging = mkdtempSync(join(tmpdir(), "cws-package-"));
  try {
    cpSync(dir, staging, { recursive: true });
    let uploadManifest;
    try {
      uploadManifest = manifestForUpload(manifest, itemId());
    } catch (error) {
      fail(error.message);
    }
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(uploadManifest, null, 2)}\n`);

    const files = listFiles(staging);
    const forbidden = forbiddenPackagePaths(files);
    if (forbidden.length > 0) fail(`refusing to package ${forbidden.join(", ")}`);
    const withKeys = files.filter((path) => containsPrivateKey(readFileSync(join(staging, path), "latin1")));
    if (withKeys.length > 0) fail(`private key material in ${withKeys.join(", ")}`);

    const out = resolve(values.out);
    rmSync(out, { force: true });
    // -X drops extra file attributes; run inside the directory so the manifest
    // sits at the zip root, which is what the store requires.
    execFileSync("zip", ["-q", "-X", "-r", out, "."], { cwd: staging, stdio: "inherit" });

    const listed = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).split("\n").filter(Boolean);
    if (!listed.includes("manifest.json")) fail(`${out} has no manifest.json at its root`);

    console.log(`packaged ${relative(repoRoot, dir) || dir} → ${out}`);
    console.log(`  version ${uploadManifest.version}${uploadManifest.version_name ? ` (${uploadManifest.version_name})` : ""}, ${listed.length} entries, key field removed: ${"key" in manifest}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

const publishCommand = async (values) => {
  if (!values.tag) fail("publish needs --tag vX.Y.Z");
  if (!values.zip) fail("publish needs --zip <file>");
  let tag;
  try {
    tag = parseReleaseTag(values.tag);
  } catch (error) {
    fail(error.message);
  }
  if (tag.prerelease) fail(`${values.tag} is a prerelease; the store has one public channel, so prereleases are not uploaded.`);

  const json = process.env.CWS_SERVICE_ACCOUNT_JSON ?? "";
  const publisherId = process.env.CWS_PUBLISHER_ID?.trim() ?? "";
  if (json === "" || publisherId === "") fail("publish needs CWS_SERVICE_ACCOUNT_JSON and CWS_PUBLISHER_ID.");

  const uploadOnly = values["upload-only"] === true;
  const log = (line) => console.log(line);
  const warn = (line) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${line}` : `warning: ${line}`);
  try {
    // Validate the request before anything is uploaded.
    const request = uploadOnly ? null : publishRequest({ deployPercentage: values["deploy-percentage"], staged: values.staged === true });
    const account = parseServiceAccount(json);
    const accessToken = await exchangeServiceAccountToken({
      fetch,
      account,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${accessToken}`);

    const id = itemId();
    const client = createStoreClient({ fetch, accessToken, publisherId, itemId: id });
    log(`item ${id}, publisher ${publisherId}, version ${tag.version}`);

    await uploadAndWait({
      client,
      zip: readFileSync(resolve(values.zip)),
      expectedVersion: tag.version,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      log,
    });

    if (uploadOnly) {
      log("upload-only: the package is uploaded as a draft and NOT submitted for review.");
    } else {
      log(`submitting: ${JSON.stringify(request)}`);
      await submit({ client, request, log, warn });
    }

    const status = await client.fetchStatus();
    log("── item status ──");
    for (const line of describeItemStatus(status)) log(line);
    if (status.takenDown === true) fail("the item is taken down for a policy violation — see the Developer Dashboard.");
    if (status.warned === true) warn("the item has a policy warning — see the Developer Dashboard.");
  } catch (error) {
    fail(error.message);
  }
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    dir: { type: "string" },
    out: { type: "string" },
    zip: { type: "string" },
    "upload-only": { type: "boolean" },
    "deploy-percentage": { type: "string" },
    staged: { type: "boolean" },
  },
});

switch (positionals[0]) {
  case "package":
    packageCommand(values);
    break;
  case "publish":
    await publishCommand(values);
    break;
  default:
    fail("usage: chrome-web-store.mjs package|publish --tag vX.Y.Z ...");
}
