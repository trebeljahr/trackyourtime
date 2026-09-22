/*
 * Mobile release rules for `.github/workflows/mobile-release.yml`, run through
 * `scripts/mobile-release-plan.mjs`. Pure — every input is an argument — so
 * each rule is a unit test (`mobile-release.test.mjs`) rather than a tag.
 *
 * The workflow runs on every `v*` tag, and a tag run must never produce
 * something that looks like a release and is not one. That decides the shape:
 *
 *   - A complete secret set builds, signs and uploads.
 *   - No secrets at all, on a tag: the job ends green with a notice and uploads
 *     NO artifact. An unsigned .aab attached to a tag's run in a public repo
 *     reads as a release download for 90 days.
 *   - No secrets, on a manual dispatch: an unsigned Android bundle named
 *     `-unsigned`, and an iOS compile check with no artifact. Somebody asked for
 *     it, and the name says what it is.
 *   - A partial set is an error on every event. Skipping it would hide the
 *     missing half behind a green run — the same rule as the desktop and
 *     Chrome Web Store releases.
 *
 * The tag is checked against package.json with desktop-release.mjs's
 * `tagMismatch`; package.json against the native versions (MARKETING_VERSION,
 * versionName) is `scripts/build-mobile.mjs`'s assertion. Together they tie a
 * tag to what the stores are told — which is why a prerelease tag never
 * reaches iOS: `v0.2.0-rc.1` needs package.json `0.2.0-rc.1`, build-mobile
 * then needs MARKETING_VERSION `0.2.0-rc.1`, and App Store Connect refuses a
 * CFBundleShortVersionString that is not dotted integers. Android's
 * versionName is free text, so its prerelease path (internal track) stands.
 *
 * The build numbers (versionCode, CURRENT_PROJECT_VERSION) are `buildNumber`
 * below, from the run number AND the attempt: both stores refuse a number they
 * have seen, and "Re-run all jobs" keeps the run number.
 */

import { tagMismatch } from "./desktop-release.mjs";

/** What android/app/build.gradle's signing block needs, as GitHub secrets. */
export const ANDROID_SIGNING_SECRETS = Object.freeze([
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
]);

/** The Play upload's credentials. Useless without signing: Play refuses an unsigned bundle. */
export const PLAY_SECRETS = Object.freeze(["PLAY_SERVICE_ACCOUNT_JSON", "ANDROID_PACKAGE_NAME"]);

/**
 * The iOS set. The API key is part of it, not an optional upload extra: the
 * archive and export fetch their provisioning profiles with it
 * (`-allowProvisioningUpdates`), so a certificate alone cannot build an IPA.
 */
export const IOS_SECRETS = Object.freeze([
  "APPLE_CERTIFICATE_BASE64",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_API_KEY_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
]);

/** Play Console tracks the workflow may upload to. */
export const PLAY_TRACKS = Object.freeze(["internal", "alpha", "beta", "production"]);

/** A GitHub secret that is not set expands to "", which is also unset. */
function isSet(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[]} names
 * @returns {{ state: "absent" | "complete" | "partial", present: string[], missing: string[] }}
 */
export function secretSetState(env, names) {
  const present = names.filter((name) => isSet(env, name));
  const missing = names.filter((name) => !isSet(env, name));
  const state = present.length === 0 ? "absent" : missing.length === 0 ? "complete" : "partial";
  return { state, present, missing };
}

/**
 * @param {string} refName
 * @returns {boolean} true for `v1.2.0-rc.1` and any other tag with a prerelease part
 */
export function isPrereleaseTag(refName) {
  return /^v\d+\.\d+\.\d+-/.test(refName);
}

/**
 * The store build number for a run: versionCode on Android,
 * CURRENT_PROJECT_VERSION on iOS. `github.run_number` alone is not enough — it
 * does not grow on "Re-run all jobs", so a re-run after a successful upload
 * would offer the store a number it already holds and fail there. The attempt
 * (1-based, reset per run) breaks the tie; 100 per run leaves room for it.
 *
 * @param {{ runNumber: string | number | undefined, runAttempt: string | number | undefined }} input
 * @returns {{ buildNumber: number } | { error: string }}
 */
export function buildNumber({ runNumber, runAttempt }) {
  const run = Number(runNumber);
  const attempt = Number(runAttempt);
  if (!Number.isInteger(run) || run < 1) {
    return { error: `GITHUB_RUN_NUMBER "${runNumber ?? ""}" is not a positive integer.` };
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    return { error: `GITHUB_RUN_ATTEMPT "${runAttempt ?? ""}" is not a positive integer.` };
  }
  return { buildNumber: run * 100 + attempt };
}

/**
 * The staged-rollout fraction. Empty means a full rollout; so does 1, which
 * Play would otherwise refuse as an in-progress release at 100 %.
 *
 * @param {string | undefined} raw
 * @returns {{ fraction: number | null } | { error: string }}
 */
export function parseUserFraction(raw) {
  const text = (raw ?? "").trim();
  if (text === "") return { fraction: null };
  if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(text)) {
    return { error: `user-fraction "${text}" is not a number between 0 and 1 (e.g. 0.1 for 10 %).` };
  }
  const fraction = Number(text);
  if (fraction <= 0) return { error: `user-fraction must be above 0 — got ${text}.` };
  return { fraction: fraction >= 1 ? null : fraction };
}

/**
 * Whether the Xcode project names a team for every build configuration that
 * sets a signing style. Archive cannot sign without one, and it is a project
 * setting, not a secret.
 *
 * @param {string} pbxproj
 * @returns {boolean}
 */
export function developmentTeamConfigured(pbxproj) {
  const styles = (pbxproj.match(/CODE_SIGN_STYLE = /g) ?? []).length;
  const teams = [...pbxproj.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g)].map((m) => m[1].trim().replace(/^"|"$/g, ""));
  return teams.length > 0 && teams.length >= styles && teams.every((team) => team !== "");
}

/**
 * The checks every mobile job shares: the ref, and on a tag its version.
 *
 * @param {{ refType: string, refName: string, version: string }} ref
 * @returns {{ tag: string | null, prerelease: boolean, errors: string[] }}
 */
function refFacts({ refType, refName, version }) {
  const errors = [];
  const tag = refType === "tag" ? refName : null;
  if (tag !== null && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    errors.push(`'${tag}' is not a vX.Y.Z tag.`);
  }
  const mismatch = tagMismatch({ refType, refName, version });
  if (mismatch) errors.push(mismatch);
  return { tag, prerelease: tag !== null && isPrereleaseTag(tag), errors };
}

/**
 * @typedef {object} AndroidPlan
 * @property {"skip" | "signed" | "unsigned"} build
 * @property {boolean} upload       upload the signed AAB to Play
 * @property {string} track
 * @property {"completed" | "inProgress"} status
 * @property {string} userFraction  "" for a full rollout
 * @property {string[]} notices
 * @property {string[]} errors
 */

/**
 * @param {{
 *   event: string,
 *   refType: string,
 *   refName: string,
 *   version: string,
 *   env: Record<string, string | undefined>,
 *   track?: string,
 *   userFraction?: string,
 * }} input
 *   `track` and `userFraction` are the dispatch inputs on a dispatch, and the
 *   MOBILE_PLAY_TRACK / MOBILE_PLAY_USER_FRACTION repo variables on a tag.
 * @returns {AndroidPlan}
 */
export function planAndroid({ event, refType, refName, version, env, track, userFraction }) {
  const notices = [];
  const { prerelease, errors } = refFacts({ refType, refName, version });
  const tagPush = event === "push" && refType === "tag";

  const signing = secretSetState(env, ANDROID_SIGNING_SECRETS);
  const play = secretSetState(env, PLAY_SECRETS);
  if (signing.state === "partial") {
    errors.push(
      `The Android signing secrets are incomplete. Set: ${signing.present.join(", ")}. Missing: ${signing.missing.join(", ")}. ` +
        "Set all four to sign, or none of them.",
    );
  }
  if (play.state === "partial") {
    errors.push(
      `The Play upload secrets are incomplete. Set: ${play.present.join(", ")}. Missing: ${play.missing.join(", ")}.`,
    );
  }
  if (play.state === "complete" && signing.state === "absent") {
    errors.push("The Play upload secrets are set but the signing secrets are not. Play refuses an unsigned bundle.");
  }

  let chosenTrack = (track ?? "").trim() || "internal";
  if (!PLAY_TRACKS.includes(chosenTrack)) {
    errors.push(`Play track "${chosenTrack}" is not one of ${PLAY_TRACKS.join(", ")}.`);
  }
  const parsed = parseUserFraction(userFraction);
  let fraction = "error" in parsed ? null : parsed.fraction;
  if ("error" in parsed) errors.push(parsed.error);

  // A prerelease is for testers. On a tag it is moved to internal whatever the
  // variables say; asked for by hand it is refused, so nobody believes an rc
  // reached production.
  if (prerelease && chosenTrack !== "internal") {
    if (tagPush) {
      notices.push(`${refName} is a prerelease — uploading to the internal track, not ${chosenTrack}.`);
      chosenTrack = "internal";
      fraction = null;
    } else {
      errors.push(`${refName} is a prerelease; prereleases go to the internal track only.`);
    }
  }
  if (fraction !== null && chosenTrack === "internal") {
    errors.push("The internal track has no staged rollout. Leave user-fraction empty, or pick alpha, beta or production.");
  }

  let build = "skip";
  if (signing.state === "complete") {
    build = "signed";
  } else if (signing.state === "absent") {
    if (tagPush) {
      notices.push(
        "The Android signing secrets are not set — nothing built and no artifact uploaded. See docs/deploy.md → Android release signing.",
      );
    } else {
      build = "unsigned";
      notices.push("The Android signing secrets are not set — building an UNSIGNED bundle, named -unsigned. Play refuses it.");
    }
  }

  const upload = build === "signed" && play.state === "complete";
  if (build === "signed" && play.state === "absent") {
    notices.push("PLAY_SERVICE_ACCOUNT_JSON and ANDROID_PACKAGE_NAME are not set — signed bundle built, Play upload skipped.");
  }

  return {
    build: errors.length > 0 ? "skip" : build,
    upload: errors.length > 0 ? false : upload,
    track: chosenTrack,
    status: fraction === null ? "completed" : "inProgress",
    userFraction: fraction === null ? "" : String(fraction),
    notices,
    errors,
  };
}

/**
 * @typedef {object} IosPlan
 * @property {"skip" | "check" | "signed"} build
 *   check: compile with signing off, no artifact
 * @property {boolean} upload  upload the IPA to TestFlight
 * @property {string[]} notices
 * @property {string[]} errors
 */

/**
 * iOS has one destination, TestFlight, and only stable tags and dispatches
 * reach it: a prerelease tag is skipped with a notice (see the header — Apple
 * refuses the marketing version the tag implies). App Store submission and
 * its phased release are App Store Connect steps.
 *
 * @param {{
 *   event: string,
 *   refType: string,
 *   refName: string,
 *   version: string,
 *   env: Record<string, string | undefined>,
 *   developmentTeam: boolean,
 *   exportOptions: boolean,
 * }} input
 * @returns {IosPlan}
 */
export function planIos({ event, refType, refName, version, env, developmentTeam, exportOptions }) {
  const notices = [];
  const { prerelease, errors } = refFacts({ refType, refName, version });
  const tagPush = event === "push" && refType === "tag";
  const secrets = secretSetState(env, IOS_SECRETS);

  let build = "skip";
  if (secrets.state === "partial") {
    errors.push(
      `The iOS signing secrets are incomplete. Set: ${secrets.present.join(", ")}. Missing: ${secrets.missing.join(", ")}. ` +
        "Set all five to sign, or none of them.",
    );
  } else if (prerelease) {
    // Whatever the event: a dispatch of the tag would fail the same way, at
    // build-mobile's MARKETING_VERSION check or at App Store Connect.
    notices.push(
      `${refName} is a prerelease — iOS skipped. Apple refuses a prerelease marketing version; ` +
        "TestFlight builds come from stable tags or a dispatch.",
    );
  } else if (secrets.state === "complete") {
    // The secrets are the switch; the two project facts are then required.
    // Without them Archive fails after a twenty-minute build.
    if (!developmentTeam) {
      errors.push("The iOS secrets are set but ios/App/App.xcodeproj has no DEVELOPMENT_TEAM for every configuration.");
    }
    if (!exportOptions) {
      errors.push("The iOS secrets are set but ios/App/ExportOptions.plist is not committed.");
    }
    build = "signed";
  } else if (tagPush) {
    notices.push("The iOS signing secrets are not set — nothing built and no artifact uploaded. See docs/deploy.md → iOS release.");
  } else {
    build = "check";
    notices.push("The iOS signing secrets are not set — compiling with signing off. No archive, no artifact.");
  }

  return {
    build: errors.length > 0 ? "skip" : build,
    upload: errors.length === 0 && build === "signed",
    notices,
    errors,
  };
}
