#!/usr/bin/env node
/*
 * Upload one Linux leg's snap to the Snap Store, for the release workflow:
 *
 *   node scripts/snap-publish.mjs [--dir release] [--dry-run]
 *
 * The decision is `snapPublishPlan` in scripts/lib/desktop-release.mjs, so it
 * is a unit test rather than a tag push. Nothing here is signed — no Linux
 * artifact is (docs/deploy.md) — and nothing here touches the GitHub release:
 * the draft-release job never attaches a snap.
 *
 * Without SNAPCRAFT_STORE_CREDENTIALS this prints a notice and exits 0, the
 * same all-or-none rule the other channels follow: one credential, so "not
 * set" is a repo that does not publish to the Snap Store rather than a typo.
 * With it set, a failed upload fails the leg — Snap Store review runs on
 * upload, and a refusal must not pass quietly.
 *
 * The channel is `candidate`, never `stable`: publishing is a person's
 * decision (docs/linux-stores.md → "Promote the snap").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SNAP_CREDENTIALS_VAR, SNAP_NAME, snapPublishPlan } from "./lib/desktop-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`::error::${name} needs a value.`);
    process.exit(1);
  }
  return value;
}

const dir = resolve(repoRoot, option("--dir", "release"));
const dryRun = process.argv.includes("--dry-run");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const plan = snapPublishPlan({
  refType: process.env.GITHUB_REF_TYPE ?? "branch",
  refName: process.env.GITHUB_REF_NAME ?? "",
  version,
  env: process.env,
});

if (plan.problem) {
  console.error(`::error::${plan.problem}`);
  process.exit(1);
}
if (!plan.publish) {
  console.log(`::notice::Not uploading to the Snap Store: ${plan.skip}`);
  process.exit(0);
}

// One leg builds one architecture, so more than one snap means the glob picked
// up another run's file — uploading the wrong architecture to a channel is not
// something the Store lets you take back.
const snaps = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".snap")) : [];
if (snaps.length !== 1) {
  console.error(`::error::Expected exactly one .snap in ${dir}, found ${snaps.length}${snaps.length ? `: ${snaps.join(", ")}` : ""}.`);
  process.exit(1);
}
const file = join(dir, snaps[0]);

console.log(`Uploading ${snaps[0]} to ${SNAP_NAME} on the ${plan.channel} channel.`);
if (dryRun) {
  console.log("--dry-run: nothing was uploaded.");
  process.exit(0);
}

// snapcraft reads the credential from the environment; it is never an argument.
const result = spawnSync("snapcraft", ["upload", "--release", plan.channel, file], {
  stdio: "inherit",
  env: { ...process.env, [SNAP_CREDENTIALS_VAR]: process.env[SNAP_CREDENTIALS_VAR] },
});
if (result.error) {
  console.error(`::error::Could not run snapcraft: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`::error::snapcraft upload failed (exit ${result.status}). Snap Store review runs on upload; read the output above.`);
  process.exit(result.status ?? 1);
}
console.log(`::notice::${snaps[0]} is on the ${plan.channel} channel. Promote it to stable when the GitHub release is published (docs/linux-stores.md).`);
