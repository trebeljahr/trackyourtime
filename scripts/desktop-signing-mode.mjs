#!/usr/bin/env node
/*
 * Print how a desktop channel will be signed, for the release workflow:
 *
 *   node scripts/desktop-signing-mode.mjs <mac|mas|win|win-store|linux>
 *
 * Writes `mode=signed|unsigned|store|skip` to $GITHUB_OUTPUT when set. Uses
 * the same `resolveSigning` build-desktop.mjs calls, so the workflow's verify
 * steps and the build can never disagree. A partial secret set exits 1; a
 * Microsoft Store leg with none of its Partner Center identity is `skip`, since a
 * repo that does not publish to the Store has nothing to fix.
 */
import { appendFileSync } from "node:fs";

import { resolveSigning, windowsStoreIdentityState } from "./lib/desktop-release.mjs";

const channel = process.argv[2];
let mode;
try {
  mode = resolveSigning(channel, process.env).mode;
} catch (err) {
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  // Only a Store leg with no identity at all is skipped; a partial one is a
  // typo in a repo that does publish to the Store, and fails like any other.
  if (channel !== "win-store" || windowsStoreIdentityState(process.env) !== "absent") {
    console.log(`::error::${message}`);
    process.exit(1);
  }
  console.log(`::notice::Skipping the Microsoft Store package: ${message}`);
  mode = "skip";
}
console.log(`${channel}: ${mode}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
