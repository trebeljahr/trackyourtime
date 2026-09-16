#!/usr/bin/env node
// Writes the client image's /version.json: which commit and release version
// the static export was built from, and the API origin baked into it.
//
// Read by CI after a deploy (.github/workflows/build-and-deploy.yml polls
// `.commit` and checks `.apiUrl`) and by open browser tabs, which compare
// `.commit` with the NEXT_PUBLIC_BUILD_COMMIT baked into their bundle to offer
// a reload (packages/client/src/lib/deploy-version.ts). JSON.stringify rather
// than printf, so no value can break the quoting.
//
// Usage: node scripts/write-version-json.mjs <out-file>
// Reads COMMIT_SHA and NEXT_PUBLIC_API_URL from the environment; the version
// comes from the root package.json.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/write-version-json.mjs <out-file>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const body = {
  commit: process.env.COMMIT_SHA ?? "",
  version: typeof version === "string" ? version : "",
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
};
writeFileSync(target, `${JSON.stringify(body)}\n`);
