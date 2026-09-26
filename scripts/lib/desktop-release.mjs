/*
 * Desktop release rules shared by `scripts/build-desktop.mjs`,
 * `electron-builder.config.mjs`, `scripts/desktop-manifests.mjs` and the
 * release workflow. Pure — every input is an argument — so each rule is a unit
 * test (`desktop-release.test.mjs`) rather than a CI run on another OS.
 *
 * Signing follows the Android rule (docs/deploy.md): no secrets at all builds
 * an artifact that says it is unsigned in its file name; a complete set signs;
 * anything in between refuses, because a half-configured set is a typo that
 * would otherwise ship an unsigned build under a signed build's name.
 */

/** Every desktop artifact family the release workflow produces. */
export const CHANNELS = Object.freeze(["mac", "mas", "win", "win-store", "linux"]);

/**
 * Environment variables each channel's signing needs, as electron-builder
 * reads them. The workflow maps its secrets onto these names.
 *
 * mac:  Developer ID Application certificate (p12) + notarization API key.
 *       A signed build that is not notarized is still blocked by Gatekeeper,
 *       so notarization is part of the set, not optional.
 * mas:  Apple Distribution + Mac Installer Distribution (one p12), the
 *       provisioning profile, and the team id the app group is named after.
 * win:  EITHER a certificate file (signtool) OR Azure Trusted Signing.
 */
export const SIGNING_SETS = Object.freeze({
  mac: [["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]],
  mas: [["CSC_LINK", "CSC_KEY_PASSWORD", "MAS_PROVISIONING_PROFILE", "APPLE_TEAM_ID"]],
  win: [
    ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
    [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT",
      "AZURE_TRUSTED_SIGNING_PROFILE",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ],
  ],
  "win-store": [],
  linux: [],
});

/**
 * The variables whose presence means "sign this channel". The others in the
 * set are then required, but on their own start nothing: the App Store Connect
 * API key and the team id are the ones the iOS release already uses
 * (mobile-release.yml), so a repo that ships the phone app has them set without
 * meaning to sign a desktop build. A channel not listed here counts every
 * variable in its sets.
 */
export const SIGNING_TRIGGERS = Object.freeze({
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD"],
  mas: ["CSC_LINK", "CSC_KEY_PASSWORD", "MAS_PROVISIONING_PROFILE"],
});

/**
 * The Microsoft Store identity. Not secrets — Partner Center shows them on the
 * product's identity page — but never invented: a package whose identity does
 * not match the reserved name is refused on upload.
 */
export const WINDOWS_STORE_IDENTITY = Object.freeze([
  "WINDOWS_STORE_IDENTITY_NAME",
  "WINDOWS_STORE_PUBLISHER",
  "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME",
]);

/** Everything any signing path reads; stripped from a Store package build. */
export const ALL_SIGNING_VARS = Object.freeze([
  ...new Set([...Object.values(SIGNING_SETS).flat(2), "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "CSC_NAME"]),
]);

/**
 * What electron-builder signs or notarizes with on its own, whatever the
 * config says: a certificate (`WIN_CSC_LINK` falls back to `CSC_LINK`, so an
 * Apple p12 in the shell is picked up by a Windows build too), the Azure
 * endpoint the config's `azureSignOptions` is gated on, and every notarization
 * credential. Stripped from an unsigned build, or its `-unsigned` name would
 * be a lie. The team id stays: an unsigned Mac App Store build still checks
 * the entitlements and Info.plist it names.
 */
export const SIGNING_CREDENTIAL_VARS = Object.freeze([
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_KEYCHAIN_PROFILE",
]);

/** A GitHub secret that is not set expands to "", which is also unset. */
function isSet(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

/**
 * @returns {{ mode: "signed" | "unsigned" | "store", set?: string[] }}
 * @throws {Error} on a partial set, two complete sets, or an unknown channel
 */
export function resolveSigning(channel, env) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown desktop channel "${channel}". Expected one of: ${CHANNELS.join(", ")}.`);
  }

  if (channel === "win-store") {
    const present = WINDOWS_STORE_IDENTITY.filter((name) => isSet(env, name));
    if (present.length !== WINDOWS_STORE_IDENTITY.length) {
      const missing = WINDOWS_STORE_IDENTITY.filter((name) => !isSet(env, name));
      throw new Error(
        `A Microsoft Store package needs its Partner Center identity. Missing: ${missing.join(", ")}.\n` +
          "  Copy them from Partner Center → the product → Product identity (docs/deploy.md).",
      );
    }
    return { mode: "store" };
  }

  const sets = SIGNING_SETS[channel];
  const complete = [];
  const triggers = SIGNING_TRIGGERS[channel];
  for (const set of sets) {
    const present = set.filter((name) => isSet(env, name));
    const started = present.filter((name) => !triggers || triggers.includes(name));
    if (present.length === set.length) {
      complete.push(set);
    } else if (started.length > 0) {
      const missing = set.filter((name) => !isSet(env, name));
      throw new Error(
        `The ${channel} signing secrets are incomplete. Set: ${present.join(", ")}. Missing: ${missing.join(", ")}.\n` +
          "  Set all of them to sign, or none of them for an artifact named -unsigned.",
      );
    }
  }
  if (complete.length > 1) {
    throw new Error(
      `Two complete ${channel} signing configurations are set (${complete.map((s) => s[0]).join(" and ")}). ` +
        "Keep one, so which certificate signed a release is never a guess.",
    );
  }
  return complete.length === 1 ? { mode: "signed", set: complete[0] } : { mode: "unsigned" };
}

/**
 * The environment electron-builder runs in for a channel.
 *
 * Unsigned: identity auto-discovery is off, so a developer's keychain never
 * signs a build by accident and every machine produces the same thing; the
 * artifact name gets `-unsigned`. Store: every signing variable is removed —
 * Partner Center signs the package, and a package signed with a certificate
 * whose subject differs from the reserved publisher fails to build at all.
 */
export function builderEnvFor(channel, env, signing) {
  const next = { ...env, TRACKYOURTIME_DESKTOP_CHANNEL: channel };
  delete next.TRACKYOURTIME_UNSIGNED;
  if (signing.mode === "unsigned") {
    for (const name of SIGNING_CREDENTIAL_VARS) delete next[name];
    next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    next.TRACKYOURTIME_UNSIGNED = "1";
  }
  if (signing.mode === "store") {
    for (const name of ALL_SIGNING_VARS) delete next[name];
    next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }
  if (signing.mode === "signed") {
    // Deliberately NOT CSC_IDENTITY_AUTO_DISCOVERY=false, which reads like
    // "pin the identity to the certificate we named" and means "do not sign
    // macOS at all": app-builder-lib checks that variable before it looks at
    // CSC_LINK, logs `skipped macOS application code signing reason=,` and
    // packages an ad-hoc signed app — with no entitlements and no hardened
    // runtime, under a file name that does NOT say -unsigned, because the mode
    // really is signed. Both Apple legs did exactly that on run 36273933100,
    // and it was the signature verification, not the build, that caught it.
    //
    // Nothing is needed here instead. The flag only governs searching a
    // keychain for an identity, and CSC_LINK does not go through that search:
    // electron-builder imports the p12 into a throwaway keychain and signs
    // with the identity inside it, so a developer's login keychain is not a
    // fallback for a signed build either way.
    delete next.CSC_IDENTITY_AUTO_DISCOVERY;
  }
  return next;
}

/**
 * The Microsoft Store identity is present in full, absent in full, or a typo.
 * The release workflow skips a Store leg only when it is absent: a partial
 * identity is somebody trying to publish, and skipping it would look like
 * success with no package.
 */
export function windowsStoreIdentityState(env) {
  const present = WINDOWS_STORE_IDENTITY.filter((name) => isSet(env, name)).length;
  return present === 0 ? "absent" : present === WINDOWS_STORE_IDENTITY.length ? "complete" : "partial";
}

/**
 * electron-builder's target names among the arguments after `--package`
 * (`--mac dmg zip --arm64` → dmg, zip). Flags and their `=` values are skipped.
 */
function builderTargets(builderArgs) {
  return builderArgs.filter((arg) => !arg.startsWith("-")).map((arg) => arg.split(":")[0].toLowerCase());
}

/**
 * An AppX is only ever built by the win-store channel, and that channel builds
 * nothing else. Built any other way, electron-builder fills the identity with
 * placeholders (`CN=ms`, the package name) and writes a package that looks
 * like a Store upload; and the Store channel names nothing `-unsigned`, so an
 * nsis installer built under it would carry a signed build's name.
 *
 * @returns {string | null} the refusal, or null
 */
export function targetChannelProblem(channel, builderArgs) {
  const targets = builderTargets(builderArgs);
  const appx = targets.filter((t) => t === "appx");
  if (channel === "win-store") {
    if (appx.length === 0 || appx.length !== targets.length) {
      return `The win-store channel builds the AppX only (--win appx); got: ${targets.join(" ") || "no target"}.`;
    }
    return null;
  }
  if (appx.length > 0) {
    return "An AppX needs the Partner Center identity: build it with --channel win-store (docs/deploy.md → Desktop release).";
  }
  return null;
}

/** Where direct downloads are published and where their updater looks (Stage 7). */
export const UPDATE_FEED = Object.freeze({
  provider: "github",
  owner: "trebeljahr",
  repo: "trackyourtime",
  // electron-builder only ever uploads into a draft; a person publishes it,
  // and publishing is what makes installed apps see the release.
  releaseType: "draft",
});

/**
 * The electron-builder `publish` value for a build, which decides whether the
 * app gets an `app-update.yml` (and the release a `latest*.yml`) at all.
 *
 * - mac and win: only when signed. Squirrel.Mac refuses to install into an
 *   unsigned app, and an `-unsigned` test build must never replace itself
 *   with a release.
 * - linux: always. Nothing on Linux is signed; the AppImage is the only one
 *   of its packages that updates itself, and the app decides that at runtime
 *   (`electron/src/updater-model.ts`) because electron-builder writes the same
 *   file into the deb, rpm and snap.
 * - mas, win-store and local builds: never.
 *
 * Always `null`, never `undefined`, when there is no feed: with `publish`
 * unset, electron-builder guesses a GitHub feed whenever GH_TOKEN or
 * GITHUB_TOKEN is in the environment — which it is on every CI runner.
 *
 * @returns {typeof UPDATE_FEED | null}
 */
export function updateFeedFor({ channel, unsigned }) {
  if (channel === "linux") return UPDATE_FEED;
  if ((channel === "mac" || channel === "win") && !unsigned) return UPDATE_FEED;
  return null;
}

/**
 * Artifact names, one place. electron-builder expands `${version}` and
 * `${arch}`; `desktop-manifests.mjs` fills the same shapes with real values to
 * build download URLs, so a rename here cannot leave a cask pointing at a file
 * that no release contains.
 */
export function artifactPatterns({ unsigned }) {
  const suffix = unsigned ? "-unsigned" : "";
  return {
    dmg: `TrackYourTime-\${version}-mac-\${arch}${suffix}.\${ext}`,
    zip: `TrackYourTime-\${version}-mac-\${arch}${suffix}.\${ext}`,
    mas: `TrackYourTime-\${version}-mas-\${arch}${suffix}.\${ext}`,
    // One installer carries both architectures (electron-builder combines
    // them when nsis is built for more than one), so no ${arch}.
    nsis: `TrackYourTime-Setup-\${version}${suffix}.\${ext}`,
    // Uploaded to Partner Center, which signs it; never installed directly.
    appx: "TrackYourTime-${version}-${arch}-store.${ext}",
    linux: "TrackYourTime-${version}-linux-${arch}.${ext}",
  };
}

/** Expand one pattern the way electron-builder does, for the manifests. */
export function expandArtifactName(pattern, values) {
  return pattern.replace(/\$\{(\w+)\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`No value for \${${key}} in ${pattern}`);
    return values[key];
  });
}

/**
 * On a tag run the tag must name the version being packaged: electron-builder
 * reads the root package.json, and a `v0.2.0` tag over a `0.1.0` package.json
 * would publish a 0.1.0 app as 0.2.0's download.
 */
export function tagMismatch({ refType, refName, version }) {
  if (refType !== "tag") return null;
  return refName === `v${version}` ? null : `Tag ${refName} does not match package.json version ${version} (expected v${version}).`;
}

/**
 * Defined here rather than in `mobile-release.mjs`, which re-exports it: that
 * module already imports `tagMismatch` from this one, and a second definition
 * is how two release paths start disagreeing about what a prerelease is.
 *
 * @param {string} refName
 * @returns {boolean} true for `v1.2.0-rc.1` and any other tag with a prerelease part
 */
export function isPrereleaseTag(refName) {
  return /^v\d+\.\d+\.\d+-/.test(refName);
}

/** The snap's registered Snap Store name, and the one credential that publishes it. */
export const SNAP_NAME = "trackyourtime";
export const SNAP_CREDENTIALS_VAR = "SNAPCRAFT_STORE_CREDENTIALS";

/**
 * Where a tag's snap is released.
 *
 * **Never `stable` from CI.** A tag builds a DRAFT GitHub release and a person
 * publishes it, and publishing is the release decision (`releasePlan` above,
 * docs/deploy.md → "Desktop release"). A `stable` upload would hand the snap to
 * every installed copy before that decision, so the tag run uploads to
 * `candidate` and `snapcraft release` promotes it afterwards
 * (docs/linux-stores.md). A prerelease tag stops at `beta`, the same rule that
 * keeps `mobile-release.yml` on Play's internal track.
 */
export const SNAP_RELEASE_CHANNEL = "candidate";
export const SNAP_PRERELEASE_CHANNEL = "beta";

/**
 * Whether this run uploads the snap it just built, and to which channel.
 *
 * All-or-none, like every other channel — and with one secret, "none" is
 * simply "not set", so it is a notice and a green leg rather than a failure.
 * A repo that does not publish to the Snap Store has nothing to fix, exactly
 * as a Microsoft Store leg with no Partner Center identity is skipped.
 *
 * @param {{ refType: string, refName: string, version: string, env: Record<string, string | undefined> }} input
 * @returns {{ publish: boolean, channel: string | null, skip: string | null, problem: string | null }}
 */
export function snapPublishPlan({ refType, refName, version, env }) {
  const skip = (reason) => ({ publish: false, channel: null, skip: reason, problem: null });
  if (!isSet(env, SNAP_CREDENTIALS_VAR)) {
    return skip(`${SNAP_CREDENTIALS_VAR} is not set, so the snap stays a CI artifact (docs/linux-stores.md).`);
  }
  if (refType !== "tag") return skip(`${refName || refType} is not a tag: the Snap Store is only uploaded to from a v* tag.`);
  const mismatch = tagMismatch({ refType, refName, version });
  if (mismatch) return { publish: false, channel: null, skip: null, problem: mismatch };
  return {
    publish: true,
    channel: isPrereleaseTag(refName) ? SNAP_PRERELEASE_CHANNEL : SNAP_RELEASE_CHANNEL,
    skip: null,
    problem: null,
  };
}

/**
 * The Mac App Store entitlements for the main app.
 *
 * Electron under the App Sandbox needs an application group named
 * `<team id>.<bundle id>` for its own IPC (Electron's MAS submission guide).
 * A build with no team id is an unsigned local check of the config and cannot
 * be submitted, so the group is left out rather than filled with a guess.
 *
 * `files.user-selected.read-write` covers the save dialog of every export
 * (CSV, PDF, JSON) and the file picker of the importer; network.client is the
 * API and its socket. Nothing else is requested: no camera, no location, no
 * Downloads folder, no Apple Events.
 */
export function masEntitlementsPlist({ teamId, appId }) {
  const group =
    teamId && teamId.trim() !== ""
      ? `
    <key>com.apple.security.application-groups</key>
    <array>
      <string>${teamId.trim()}.${appId}</string>
    </array>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/build-desktop.mjs from scripts/lib/desktop-release.mjs. Do not edit. -->
<plist version="1.0">
  <dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>${group}
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
  </dict>
</plist>
`;
}

/**
 * The release files the package-manager manifests point at, by the placeholder
 * their checksum fills. Names come from `artifactPatterns({ unsigned: false })`:
 * a manifest is only ever rendered from a signed release, so an `-unsigned`
 * file can never satisfy it.
 */
export function manifestArtifacts(version) {
  const names = artifactPatterns({ unsigned: false });
  const name = (pattern, arch, ext) => expandArtifactName(pattern, { version, arch, ext });
  return Object.freeze({
    sha256_mac_arm64_dmg: name(names.dmg, "arm64", "dmg"),
    sha256_mac_x64_dmg: name(names.dmg, "x64", "dmg"),
    sha256_win_nsis: name(names.nsis, "", "exe"),
    sha256_linux_x64_targz: name(names.linux, "x64", "tar.gz"),
    sha256_linux_arm64_targz: name(names.linux, "arm64", "tar.gz"),
  });
}

/**
 * Placeholders whose checksum is computed from a file in THIS checkout rather
 * than from a release artifact: the Flathub manifest fetches both at the
 * release tag, and the workflow renders from that tag. Keyed by placeholder so
 * `desktop-manifests.mjs` and its test read one list.
 */
export const REPO_FILE_CHECKSUMS = Object.freeze({
  sha256_icon_png: "build/icon.png",
  // Flathub requires the licence inside the build
  // (/app/share/licenses/<app id>), and the tar.gz carries only Electron's and
  // Chromium's.
  sha256_license: "LICENSE",
});

/** Which placeholders each manifest family needs, so one family renders alone. */
export const MANIFEST_FAMILIES = Object.freeze({
  homebrew: ["sha256_mac_arm64_dmg", "sha256_mac_x64_dmg"],
  winget: ["sha256_win_nsis"],
  flatpak: ["sha256_linux_x64_targz", "sha256_linux_arm64_targz", "sha256_icon_png", "sha256_license"],
});

/**
 * A family renders only when the release really carries every file its
 * checksums come from. `sha256_icon_png` is not one of them: it is hashed out
 * of the checkout at the tag, not out of the release.
 *
 * This is what lets one unsigned leg cost that leg alone. A release attaches no
 * `-unsigned` file (`releasePlan`), so an unsigned Windows build leaves no
 * installer for winget to point at — and before this the whole manifest run
 * failed on it, taking the Homebrew cask of a perfectly signed macOS build with
 * it.
 *
 * @param {{ version: string, families: string[], has: (fileName: string) => boolean }} input
 * @returns {{ render: string[], skipped: { family: string, missing: string[] }[] }}
 */
export function manifestFamilyPlan({ version, families, has }) {
  const files = manifestArtifacts(version);
  const render = [];
  const skipped = [];
  for (const family of families) {
    const keys = MANIFEST_FAMILIES[family];
    if (!keys) throw new Error(`Unknown manifest family "${family}".`);
    const missing = keys.filter((key) => key in files && !has(files[key])).map((key) => files[key]);
    if (missing.length > 0) skipped.push({ family, missing });
    else render.push(family);
  }
  return { render, skipped };
}

/**
 * The winget package identifier. Permanent, like every other identifier in
 * CLAUDE.md → "Product name": winget keys an installed package by it, so a
 * rename leaves every install pinned to a package that no longer receives
 * versions. It is `<Publisher>.<Package>` and it is NOT the Homebrew cask
 * token, the bundle id or the Flatpak app id.
 */
export const WINGET_PACKAGE_IDENTIFIER = "ricoslabs.trackyourtime";

/**
 * Where microsoft/winget-pkgs keeps one version's manifests: the identifier's
 * first character lowercased as the partition folder, then every dot-separated
 * part of the identifier verbatim, then the version. `wingetcreate submit`
 * derives the same path from the manifests themselves, so this exists to say
 * in one place what a reviewer is looking at — and to keep a comment from
 * naming a path the identifier does not produce.
 */
export function wingetManifestPath(version, identifier = WINGET_PACKAGE_IDENTIFIER) {
  const parts = identifier.split(".");
  if (parts.length < 2 || parts.some((part) => part === "")) {
    throw new Error(`A winget PackageIdentifier is "<Publisher>.<Package>"; got "${identifier}".`);
  }
  return ["manifests", parts[0][0].toLowerCase(), ...parts, version].join("/");
}

/**
 * The pull request title in the shape winget-pkgs uses, which its reviewers
 * scan. A package's first version is announced differently from the ones after
 * it — a fact about that repository rather than about this release, so it is
 * decided from whether the package is already listed, never assumed.
 */
export function wingetPrTitle({ version, exists, identifier = WINGET_PACKAGE_IDENTIFIER }) {
  return `${exists ? "New version" : "New package"}: ${identifier} version ${version}`;
}

/**
 * Fill `{{key}}` placeholders. Refuses a placeholder with no value, and a
 * value that is empty, so a manifest can never be written with a blank
 * checksum that a package manager would reject only after submission.
 */
export function renderManifestTemplate(template, values) {
  const missing = new Set();
  const out = template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const value = values[key];
    if (typeof value !== "string" || value === "") {
      missing.add(key);
      return whole;
    }
    return value;
  });
  if (missing.size) throw new Error(`No value for ${[...missing].map((k) => `{{${k}}}`).join(", ")}.`);
  return out;
}

/**
 * The update feed file each release leg must carry, when it carries one: what
 * electron-updater asks for on that platform (`latest-mac.yml` holds both mac
 * architectures, `latest.yml` the one NSIS installer, and Linux names its
 * architecture unless it is x64). Keyed by the workflow's matrix `channel`.
 */
export const FEED_FILES = Object.freeze({
  mac: "latest-mac.yml",
  win: "latest.yml",
  "linux-x64": "latest-linux.yml",
  "linux-arm64": "latest-linux-arm64.yml",
});

/** Files that go to a store or stay a CI artifact, never onto the release page. */
const STORE_ONLY = /\.(pkg|appx|snap)$/;

/**
 * What goes into the draft GitHub Release for a tag, from the legs the matrix
 * built (`desktop-<channel>-<mode>` artifacts).
 *
 * - An `-unsigned` file is never attached: a release page is where people
 *   download from, and the updater would offer nothing for it anyway. The
 *   leg's absence is a warning, so a person publishing the draft sees which
 *   platform has no download this time.
 * - Store packages (pkg, appx, snap) stay CI artifacts for a manual upload.
 * - Per-leg checksum files are replaced by one over what is attached.
 * - A leg that has a feed (signed mac and win, every Linux leg) must bring
 *   its feed file. Without it installed apps would never see this release,
 *   and nothing else would say so.
 *
 * @param {{ channel: string, mode: string, files: string[] }[]} legs
 * @returns {{ upload: string[], feeds: string[], warnings: string[], problems: string[] }}
 */
export function releasePlan(legs) {
  const upload = [];
  const feeds = [];
  const warnings = [];
  const problems = [];
  for (const leg of legs) {
    const feedFile = FEED_FILES[leg.channel];
    const hasFeed = feedFile !== undefined && (leg.channel.startsWith("linux") || leg.mode === "signed");
    if ((leg.channel === "mac" || leg.channel === "win") && leg.mode !== "signed") {
      warnings.push(`${leg.channel} was built unsigned: the draft has no ${leg.channel === "mac" ? "macOS" : "Windows"} download and no update for it.`);
    }
    for (const file of leg.files) {
      const name = file.split("/").pop();
      if (/-unsigned\./.test(name) || STORE_ONLY.test(name) || /^SHA256SUMS/.test(name)) continue;
      if (/^latest.*\.yml$/.test(name)) {
        if (hasFeed && name === feedFile) feeds.push(file);
        continue;
      }
      upload.push(file);
    }
    if (hasFeed && !leg.files.some((file) => file.split("/").pop() === feedFile)) {
      problems.push(`The ${leg.channel} leg has no ${feedFile}; installed apps would never be offered this release.`);
    }
  }
  if (upload.length === 0) problems.push("Nothing to attach: every leg was unsigned, a store package, or empty.");
  return { upload, feeds, warnings, problems };
}

/**
 * Every file a feed names must be attached, with the size and sha512 the feed
 * states, or the updater downloads it, rejects the checksum and reports an
 * error to every installed app.
 *
 * @param {{ name: string, feed: { files?: { url: string, sha512: string, size?: number }[] } }[]} feeds
 * @param {Map<string, { sha512: string, size: number }>} attached  by file name
 * @returns {string[]} problems
 */
export function feedProblems(feeds, attached) {
  const problems = [];
  for (const { name, feed } of feeds) {
    const files = Array.isArray(feed?.files) ? feed.files : [];
    if (files.length === 0) problems.push(`${name} lists no files.`);
    for (const entry of files) {
      // electron-updater's GitHub provider replaces spaces with dashes.
      const fileName = String(entry.url).replace(/ /g, "-");
      const actual = attached.get(fileName);
      if (!actual) {
        problems.push(`${name} names ${fileName}, which is not attached.`);
      } else if (actual.sha512 !== entry.sha512) {
        problems.push(`${name}: the sha512 of ${fileName} does not match the attached file.`);
      } else if (typeof entry.size === "number" && entry.size !== actual.size) {
        problems.push(`${name}: the size of ${fileName} does not match the attached file.`);
      }
    }
  }
  return problems;
}

/**
 * The lowest electron-builder (app-builder-lib) this repo may sign a macOS
 * build with.
 *
 * Through 26.16.0, `createKeychain` created its throwaway keychain with a
 * random 32-byte password and then ran
 *
 *   security set-key-partition-list -S apple-tool:,apple: -s -k <p12 password> <keychain>
 *
 * `-k` takes the KEYCHAIN's password, not the password `security import -P`
 * used for the p12. macOS 14 and 15 let the mismatch through; macOS 26 — the
 * `macos-26-arm64` image `macos-latest` now resolves to — verifies the unlock
 * and answers
 *
 *   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
 *
 * so both Apple channels died at "Build and package" with
 * `⨯ /usr/bin/security process failed 1` on the first run with real signing
 * secrets (tag v0.1.0, run 36108136377). The certificates and passwords were
 * never involved. Fixed upstream in 26.16.1 (electron-userland/electron-builder#10172),
 * which passes the keychain's own password.
 *
 * Asserted rather than assumed (`desktop-release.test.mjs`) because npm's
 * `latest` dist-tag for electron-builder still points at 26.15.3, below the
 * fix: a `pnpm update` or a hand-edited range can walk back into it, and the
 * next place that shows up is a tagged release that cannot sign macOS at all.
 */
export const MIN_APP_BUILDER_LIB = "26.16.1";

/**
 * Compare two `x.y.z` versions on their numbers alone, ignoring any
 * prerelease suffix (`27.0.0-alpha.9` counts as 27.0.0). Enough for a floor
 * check, and no semver dependency for a two-line comparison.
 *
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersionNumbers(a, b) {
  const parts = (v) => String(v).split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
