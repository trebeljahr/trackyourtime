#!/usr/bin/env node
/*
 * Print how a desktop channel will be signed and whether it carries an update
 * feed, for the release workflow:
 *
 *   node scripts/desktop-signing-mode.mjs <mac|mas|win|win-store|linux>
 *
 * Writes `mode=signed|unsigned|store|skip` and `feed=true|false` to
 * $GITHUB_OUTPUT when set. Uses the same `resolveSigning` and
 * `resolveUpdater` build-desktop.mjs calls, so the workflow's verify steps and
 * the build can never disagree. A partial secret set exits 1, and so does a
 * signed direct download without the update key; a Microsoft Store leg with
 * none of its Partner Center identity is `skip`, since a repo that does not
 * publish to the Store has nothing to fix.
 *
 * Imports nothing but pure modules and node:fs: the workflow runs it before
 * setup-node, on whatever Node the runner ships.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSigning, resolveUpdater, UPDATER_PUBKEY_FILE, windowsStoreIdentityState } from "./lib/desktop-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const channel = process.argv[2];
const output = (line) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
};

let signing;
try {
  signing = resolveSigning(channel, process.env);
} catch (err) {
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  // Only a Store leg with no identity at all is skipped; a partial one is a
  // typo in a repo that does publish to the Store, and fails like any other.
  if (channel !== "win-store" || windowsStoreIdentityState(process.env) !== "absent") {
    console.log(`::error::${message}`);
    process.exit(1);
  }
  console.log(`::notice::Skipping the Microsoft Store package: ${message}`);
  console.log(`${channel}: skip`);
  output("mode=skip");
  output("feed=false");
  process.exit(0);
}

const pubkeyPath = resolve(repoRoot, UPDATER_PUBKEY_FILE);
const pubkey = existsSync(pubkeyPath) ? readFileSync(pubkeyPath, "utf8").trim() : null;
let updater;
try {
  updater = resolveUpdater({ channel, signing, env: process.env, pubkey });
} catch (err) {
  console.log(`::error::${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  process.exit(1);
}
if (channel === "linux" && !updater.feed) {
  console.log(`::notice::No update feed for Linux (${updater.reason}): a tag's draft release refuses AppImages that cannot update.`);
}
console.log(`${channel}: ${signing.mode}, update feed ${updater.feed ? "on" : `off (${updater.reason})`}`);
output(`mode=${signing.mode}`);
output(`feed=${updater.feed}`);
