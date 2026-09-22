#!/usr/bin/env node
/*
 * Decide what a mobile release job does, for .github/workflows/mobile-release.yml:
 *
 *   node scripts/mobile-release-plan.mjs <android|ios>
 *
 * Reads the secrets' presence (never their values) from the job's env, the ref
 * from GITHUB_EVENT_NAME / GITHUB_REF_TYPE / GITHUB_REF_NAME, and for Android
 * the track and rollout from PLAY_TRACK / PLAY_USER_FRACTION. Writes `build`,
 * `upload`, `version` and, for Android, `track`, `status` and `user_fraction` to
 * $GITHUB_OUTPUT. Errors print as ::error:: and exit 1; skips print ::notice::.
 * The rules are scripts/lib/mobile-release.mjs.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { developmentTeamConfigured, planAndroid, planIos } from "./lib/mobile-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2];
const env = process.env;
const ref = {
  event: env.GITHUB_EVENT_NAME ?? "",
  refType: env.GITHUB_REF_TYPE ?? "",
  refName: env.GITHUB_REF_NAME ?? "",
  version: JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version,
};

let plan;
let outputs;
if (platform === "android") {
  plan = planAndroid({ ...ref, env, track: env.PLAY_TRACK, userFraction: env.PLAY_USER_FRACTION });
  outputs = {
    build: plan.build,
    upload: String(plan.upload),
    track: plan.track,
    status: plan.status,
    user_fraction: plan.userFraction,
    version: ref.version,
  };
} else if (platform === "ios") {
  const pbxPath = resolve(repoRoot, "ios/App/App.xcodeproj/project.pbxproj");
  plan = planIos({
    ...ref,
    env,
    developmentTeam: existsSync(pbxPath) && developmentTeamConfigured(readFileSync(pbxPath, "utf8")),
    exportOptions: existsSync(resolve(repoRoot, "ios/App/ExportOptions.plist")),
  });
  outputs = { build: plan.build, upload: String(plan.upload), version: ref.version };
} else {
  console.log(`::error::Usage: mobile-release-plan.mjs <android|ios> — got "${platform ?? ""}".`);
  process.exit(1);
}

// A refused run prints only why it was refused: a "skipped" notice beside the
// error would read as the reason.
if (plan.errors.length === 0) for (const notice of plan.notices) console.log(`::notice::${notice}`);
for (const error of plan.errors) console.log(`::error::${error}`);
console.log(`${platform}: ${Object.entries(outputs).map(([k, v]) => `${k}=${v || "-"}`).join(" ")}`);
if (plan.errors.length > 0) process.exit(1);

if (env.GITHUB_OUTPUT) {
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}
