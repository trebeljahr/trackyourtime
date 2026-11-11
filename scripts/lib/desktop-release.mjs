/*
 * Desktop release rules shared by `scripts/build-desktop.mjs`,
 * `scripts/lib/desktop-tauri.mjs`, `scripts/desktop-release-draft.mjs`,
 * `scripts/desktop-manifests.mjs` and the release workflow. Pure — every input
 * is an argument — so each rule is a unit test (`desktop-release.test.mjs`)
 * rather than a CI run on another OS.
 *
 * Signing follows the Android rule (docs/deploy.md): no secrets at all builds
 * an artifact that says it is unsigned in its file name; a complete set signs;
 * anything in between refuses, because a half-configured set is a typo that
 * would otherwise ship an unsigned build under a signed build's name.
 *
 * Updates follow two feeds at once (docs/deploy.md → "Tags, the draft release
 * and updates"):
 *
 *   - `latest.json`, which the Tauri app's updater reads (tauri-plugin-updater,
 *     minisign signatures, `TAURI_SIGNING_PRIVATE_KEY`), and
 *   - `latest-mac.yml`, `latest.yml` and `latest-linux*.yml`, which every
 *     Electron install (v0.3.0 and earlier) still reads with electron-updater.
 *     They point at the Tauri artifacts, so those installs migrate: a zip of
 *     the Developer ID app, the NSIS installer and the AppImage.
 */
import { createHash } from "node:crypto";

/** Every desktop artifact family the release workflow produces. */
export const CHANNELS = Object.freeze(["mac", "mas", "win", "win-store", "linux"]);

/**
 * Environment variables each channel's signing needs. The workflow maps its
 * secrets onto these names (the names electron-builder read, kept so the
 * secrets and their docs did not have to move).
 *
 * mac:  Developer ID Application certificate (p12) + notarization API key.
 *       A signed build that is not notarized is still blocked by Gatekeeper,
 *       so notarization is part of the set, not optional.
 * mas:  Apple Distribution + Mac Installer Distribution (one p12), the
 *       provisioning profile, and the team id the entitlements name.
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

/** The minisign key the update signatures are made with (`tauri signer generate`). */
export const UPDATER_KEY_VAR = "TAURI_SIGNING_PRIVATE_KEY";
export const UPDATER_KEY_PASSWORD_VAR = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
/**
 * The public half, committed: every installed app checks every update against
 * it, so a change is a reviewed diff and never an environment variable. Absent
 * until the first key is generated (docs/deploy.md → "The update key").
 */
export const UPDATER_PUBKEY_FILE = "build/updater.pub";

/** Everything any signing path reads; stripped from a Store package build. */
export const ALL_SIGNING_VARS = Object.freeze([
  ...new Set([...Object.values(SIGNING_SETS).flat(2), "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "CSC_NAME"]),
]);

/**
 * Credentials that sign, notarize or sign updates. Stripped from an unsigned
 * build, or its `-unsigned` name would be a lie. The team id stays: an
 * unsigned Mac App Store build still writes the entitlements it names.
 */
export const SIGNING_CREDENTIAL_VARS = Object.freeze([
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_PROFILE",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_KEYCHAIN_PROFILE",
]);

/**
 * What the Tauri CLI signs or notarizes with ON ITS OWN when it finds them in
 * its environment. None of them is ever handed to it: signing goes through the
 * throwaway keychain (`desktop-apple.mjs`) and the identity in the generated
 * config, and notarization is a separate step this repo runs and verifies.
 * `APPLE_API_KEY` is the trap — electron-builder (and this repo's secrets) mean
 * the PATH of the .p8, the Tauri CLI means the key ID, so passing it through
 * would notarize with a file name as the key id.
 */
export const TAURI_SELF_SIGNING_VARS = Object.freeze([
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_PROVIDER_SHORT_NAME",
]);

/** A GitHub secret that is not set expands to "", which is also unset. */
export function isSet(env, name) {
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
 * Whether this build carries an update feed: the updater plugin's endpoint and
 * public key in its config, and `createUpdaterArtifacts` so `tauri build`
 * writes and minisign-signs the update payload.
 *
 * - mac and win: only when signed, and then ALWAYS. An `-unsigned` test build
 *   must never replace itself with a release; a signed direct download that
 *   cannot update is a release every person who installs it is stuck on, with
 *   nothing to say so. A signed build without the update key refuses.
 * - linux: whenever the key is there. Nothing on Linux is signed, and the
 *   AppImage is the only package that updates itself — which the app decides
 *   at runtime (`tyt_model::updater_model::updater_policy`), because the deb,
 *   the rpm and the AppImage come out of one `tauri build` with one config.
 *   A tag's draft refuses a Linux leg without an update signature
 *   (`releasePlan`), so a release cannot ship AppImages that never update.
 * - mas, win-store and local builds: never. The store updates them.
 *
 * A key without the committed public key, or the reverse on a channel that
 * needs both, is a refusal: an app configured with one key and fed updates
 * signed with another rejects every update and says only "signature".
 *
 * @param {{ channel: string, signing: { mode: string }, env: Record<string, string | undefined>, pubkey: string | null }} input
 * @returns {{ feed: boolean, reason: string }}
 */
export function resolveUpdater({ channel, signing, env, pubkey }) {
  const key = isSet(env, UPDATER_KEY_VAR);
  const hasPubkey = typeof pubkey === "string" && pubkey.trim() !== "";
  const none = (reason) => ({ feed: false, reason });
  if (channel === "mas" || channel === "win-store") return none("the store updates it");
  if (!CHANNELS.includes(channel)) return none("a local build has no update feed");
  if ((channel === "mac" || channel === "win") && signing.mode !== "signed") {
    return none("an -unsigned build never replaces itself with a release");
  }
  if (key && !hasPubkey) {
    throw new Error(
      `${UPDATER_KEY_VAR} is set but ${UPDATER_PUBKEY_FILE} is not committed. Commit the public key ` +
        "`tauri signer generate` printed beside it (docs/deploy.md → \"The update key\").",
    );
  }
  if (channel === "linux") {
    return key ? { feed: true, reason: "the AppImage updates itself" } : none(`${UPDATER_KEY_VAR} is not set`);
  }
  if (!key) {
    throw new Error(
      `A signed ${channel} build must be able to update itself, and ${UPDATER_KEY_VAR} is not set.\n` +
        "  Set it (and its password) as a secret, or build without the certificate for an -unsigned artifact.",
    );
  }
  return { feed: true, reason: "a signed direct download updates itself" };
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

/** What each channel packages, and what `--bundles` may name for it. */
export const CHANNEL_BUNDLES = Object.freeze({
  mac: Object.freeze(["dmg", "zip"]),
  mas: Object.freeze(["pkg"]),
  win: Object.freeze(["nsis"]),
  "win-store": Object.freeze(["appx"]),
  linux: Object.freeze(["appimage", "deb", "rpm", "targz", "snap"]),
});

/** The host's own direct-download channel, for a build without `--channel`. */
export function hostChannel(platform) {
  return { darwin: "mac", win32: "win", linux: "linux" }[platform] ?? null;
}

/**
 * An AppX is only ever built by the win-store channel, and that channel builds
 * nothing else: built any other way it would carry no Partner Center identity
 * and look like a Store upload, and the Store channel names nothing
 * `-unsigned`, so an NSIS installer built under it would carry a signed
 * build's name. Everything else must be a bundle its channel makes.
 *
 * @param {string | null} channel  null for a local build (the host's channel, unsigned)
 * @param {string[]} bundles
 * @param {string} platform  process.platform
 * @returns {string | null} the refusal, or null
 */
export function targetChannelProblem(channel, bundles, platform) {
  const effective = channel ?? hostChannel(platform);
  if (bundles.includes("appx") && effective !== "win-store") {
    return "An AppX needs the Partner Center identity: build it with --channel win-store (docs/deploy.md → Desktop release).";
  }
  if (effective === "win-store" && (bundles.length === 0 || bundles.some((b) => b !== "appx"))) {
    return `The win-store channel builds the AppX only (--bundles appx); got: ${bundles.join(" ") || "no bundle"}.`;
  }
  const allowed = CHANNEL_BUNDLES[effective];
  if (!allowed) return `No desktop channel builds on ${platform}.`;
  const unknown = bundles.filter((b) => !allowed.includes(b));
  if (unknown.length) return `The ${effective} channel does not build ${unknown.join(", ")}. It builds: ${allowed.join(", ")}.`;
  const host = { mac: "darwin", mas: "darwin", win: "win32", "win-store": "win32", linux: "linux" }[effective];
  if (host !== platform) return `The ${effective} channel builds on ${host}, not ${platform}.`;
  return null;
}

/**
 * The environment the Tauri CLI runs in for a channel.
 *
 * Never any variable it would sign or notarize with on its own
 * (`TAURI_SELF_SIGNING_VARS`). Unsigned: no credential at all, so a developer's
 * shell can never sign a build named `-unsigned`. Store: no signing variable
 * at all — the store signs. No feed: no update key, so nothing is signed for
 * an updater the build does not have.
 */
export function tauriEnvFor({ env, signing, updater }) {
  const next = { ...env };
  for (const name of TAURI_SELF_SIGNING_VARS) delete next[name];
  if (signing.mode !== "signed") for (const name of SIGNING_CREDENTIAL_VARS) delete next[name];
  if (signing.mode === "store") for (const name of ALL_SIGNING_VARS) delete next[name];
  if (!updater.feed) {
    delete next[UPDATER_KEY_VAR];
    delete next[UPDATER_KEY_PASSWORD_VAR];
  }
  return next;
}

/** Where direct downloads are published and where their updaters look. */
export const UPDATE_FEED = Object.freeze({ owner: "trebeljahr", repo: "trackyourtime" });

/**
 * The one URL every Tauri build with a feed asks. `releases/latest` is the
 * newest PUBLISHED, non-prerelease release, so publishing the draft is the
 * release decision — the same rule electron-updater's GitHub provider had.
 */
export const UPDATER_ENDPOINT = `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases/latest/download/latest.json`;

/** Where a release's assets are downloaded from, for latest.json's URLs. */
export function releaseDownloadBase({ owner = UPDATE_FEED.owner, repo = UPDATE_FEED.repo, version }) {
  return `https://github.com/${owner}/${repo}/releases/download/v${version}/`;
}

/**
 * Artifact names, one place. Download links, `artifactPatterns()` users, the
 * Homebrew and winget templates and `desktop:try-release` all read them, and
 * they are the names the Electron releases used, so a link that worked for
 * v0.3.0 works for every release after it.
 *
 * `${arch}` is always this repo's own word (`x64`, `arm64`, `universal`);
 * `artifactName` spells it the way each format's ecosystem does, which is how
 * electron-builder named them: x86_64 for an AppImage, amd64 for a deb and a
 * snap, aarch64 for an rpm.
 */
export function artifactPatterns({ unsigned }) {
  const suffix = unsigned ? "-unsigned" : "";
  return {
    dmg: `TrackYourTime-\${version}-mac-\${arch}${suffix}.dmg`,
    zip: `TrackYourTime-\${version}-mac-\${arch}${suffix}.zip`,
    // The Tauri updater's payload: a tar.gz of the stapled .app.
    macUpdater: `TrackYourTime-\${version}-mac-\${arch}${suffix}.app.tar.gz`,
    mas: `TrackYourTime-\${version}-mas-\${arch}${suffix}.pkg`,
    // x64 keeps the name the Electron installer had, which carried both
    // architectures in one exe; Tauri builds one installer per architecture.
    nsis: `TrackYourTime-Setup-\${version}\${archSuffix}${suffix}.exe`,
    // Uploaded to Partner Center, which signs it; never installed directly.
    appx: "TrackYourTime-${version}-${arch}-store.appx",
    appimage: "TrackYourTime-${version}-linux-${arch}.AppImage",
    targz: "TrackYourTime-${version}-linux-${arch}.tar.gz",
    deb: "trackyourtime_${version}_${arch}.deb",
    rpm: "trackyourtime-${version}.${arch}.rpm",
    snap: "trackyourtime_${version}_${arch}.snap",
  };
}

const ARCH_SPELLING = Object.freeze({
  appimage: { x64: "x86_64", arm64: "arm64" },
  deb: { x64: "amd64", arm64: "arm64" },
  snap: { x64: "amd64", arm64: "arm64" },
  rpm: { x64: "x86_64", arm64: "aarch64" },
});

/** Expand one pattern, refusing a placeholder with no value. */
export function expandArtifactName(pattern, values) {
  return pattern.replace(/\$\{(\w+)\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`No value for \${${key}} in ${pattern}`);
    return values[key];
  });
}

/**
 * One artifact's file name.
 *
 * @param {keyof ReturnType<typeof artifactPatterns>} kind
 * @param {{ version: string, arch: "x64" | "arm64" | "universal", unsigned?: boolean }} input
 */
export function artifactName(kind, { version, arch, unsigned = false }) {
  const pattern = artifactPatterns({ unsigned })[kind];
  if (!pattern) throw new Error(`Unknown artifact kind "${kind}".`);
  const spelled = ARCH_SPELLING[kind]?.[arch] ?? arch;
  return expandArtifactName(pattern, { version, arch: spelled, archSuffix: arch === "arm64" ? "-arm64" : "" });
}

/**
 * On a tag run the tag must name the version being packaged: the Tauri config
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
 * publishes it, and publishing is the release decision (`releasePlan` below,
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
 * The Mac App Store entitlements.
 *
 * The App Sandbox, the API and its socket (`network.client`), and read/write
 * access to files the person picks (the save dialog of every export and the
 * importer's file picker). Nothing else: no JIT or unsigned executable memory
 * (the system WebView runs JavaScript in Apple's own WebContent process), no
 * camera, no location, no Downloads folder, no Apple Events.
 *
 * `application-identifier` and `team-identifier` are what App Store Connect
 * and TestFlight compare with the provisioning profile; electron-builder's
 * osx-sign added them from the profile, Tauri's codesign does not. A build with
 * no team id is an unsigned local check of the config and cannot be submitted,
 * so both are left out rather than filled with a guess. Electron also needed an
 * application group for its own IPC; this app has one process and none.
 */
export function masEntitlementsPlist({ teamId, appId }) {
  const team = teamId && teamId.trim() !== "" ? teamId.trim() : null;
  const identity = team
    ? `
    <key>com.apple.application-identifier</key>
    <string>${team}.${appId}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${team}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/build-desktop.mjs from scripts/lib/desktop-release.mjs. Do not edit. -->
<plist version="1.0">
  <dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>${identity}
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
 * their checksum fills. Names come from `artifactName(…, { unsigned: false })`:
 * a manifest is only ever rendered from a signed release, so an `-unsigned`
 * file can never satisfy it.
 */
export function manifestArtifacts(version) {
  const name = (kind, arch) => artifactName(kind, { version, arch });
  return Object.freeze({
    sha256_mac_arm64_dmg: name("dmg", "arm64"),
    sha256_mac_x64_dmg: name("dmg", "x64"),
    sha256_win_nsis: name("nsis", "x64"),
    sha256_win_nsis_arm64: name("nsis", "arm64"),
    sha256_linux_x64_targz: name("targz", "x64"),
    sha256_linux_arm64_targz: name("targz", "arm64"),
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
  // Flathub requires the licence inside the build (/app/share/licenses/<app id>).
  sha256_license: "LICENSE",
});

/** Which placeholders each manifest family needs, so one family renders alone. */
export const MANIFEST_FAMILIES = Object.freeze({
  homebrew: ["sha256_mac_arm64_dmg", "sha256_mac_x64_dmg"],
  winget: ["sha256_win_nsis", "sha256_win_nsis_arm64"],
  flatpak: ["sha256_linux_x64_targz", "sha256_linux_arm64_targz", "sha256_icon_png", "sha256_license"],
});

/**
 * A family renders only when the release really carries every file its
 * checksums come from. This is what lets one unsigned leg cost that leg alone:
 * a release attaches no `-unsigned` file (`releasePlan`), so an unsigned
 * Windows build leaves no installer for winget to point at, and that must not
 * take the Homebrew cask of a signed macOS build with it.
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
 * part of the identifier verbatim, then the version.
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
 * it — decided from whether the package is already listed, never assumed.
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

// ── Update feeds ──────────────────────────────────────────────────────

/**
 * The electron-updater feed each release leg must carry, for the Electron
 * installs that still read them: what electron-updater asks for on that
 * platform (`latest-mac.yml` holds both mac architectures, `latest.yml` the
 * x64 NSIS installer, and Linux names its architecture unless it is x64).
 * Keyed by the workflow's matrix `channel`.
 */
export const LEGACY_FEED_FILES = Object.freeze({
  mac: "latest-mac.yml",
  win: "latest.yml",
  "linux-x64": "latest-linux.yml",
  "linux-arm64": "latest-linux-arm64.yml",
});

/** The Tauri updater's feed, assembled by the draft job from every leg's fragment. */
export const TAURI_FEED_FILE = "latest.json";

/** One leg's share of latest.json: its signed update payloads. */
export function updaterFragmentName(leg) {
  return `updater-${leg}.json`;
}

/**
 * The latest.json keys an update payload answers. tauri-plugin-updater looks
 * for `<os>-<arch>-<installer>` first, then `<os>-<arch>`
 * (`Updater::get_urls`); both are written, so a build whose bundle type the
 * plugin cannot tell still finds its payload. A deb or rpm install never asks:
 * the app turns its updater off for package-manager installs.
 *
 * @param {"macUpdater" | "nsis" | "appimage"} kind
 * @param {"x64" | "arm64"} arch
 */
export function updaterTargets(kind, arch) {
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
  if (!cpu) throw new Error(`No updater target for architecture ${arch}.`);
  const [os, installer] = { macUpdater: ["darwin", "app"], nsis: ["windows", "nsis"], appimage: ["linux", "appimage"] }[kind] ?? [];
  if (!os) throw new Error(`No updater target for ${kind}.`);
  return [`${os}-${cpu}-${installer}`, `${os}-${cpu}`];
}

/** sha512 (base64) and size, as electron-updater's feeds state them. */
export function feedDigest(bytes) {
  return { sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
}

/**
 * One electron-updater feed, in the shape electron-builder wrote (the v0.3.0
 * feeds are the reference): `version`, `files` with url/sha512/size, then the
 * first file again as `path`/`sha512`, then `releaseDate`. No `blockMapSize`:
 * there is no blockmap, so electron-updater downloads the whole file, which is
 * the only correct thing for an Electron-to-Tauri update anyway.
 *
 * @param {{ version: string, files: { url: string, sha512: string, size: number }[], releaseDate: string, dump: (value: unknown, options?: object) => string }} input
 *   `dump` is js-yaml's, the serializer electron-builder used.
 */
export function legacyFeedText({ version, files, releaseDate, dump }) {
  if (files.length === 0) throw new Error("An update feed needs at least one file.");
  const [first] = files;
  return dump(
    {
      version,
      files: files.map(({ url, sha512, size }) => ({ url, sha512, size })),
      path: first.url,
      sha512: first.sha512,
      releaseDate,
    },
    { lineWidth: -1 },
  );
}

/**
 * The files a leg's legacy feed lists, in electron-updater's order of
 * preference. macOS: the zips first (MacUpdater installs a zip, and picks the
 * arm64 one on Apple Silicon by the "arm64" in its name), then the dmgs as
 * electron-builder listed them. Windows: the x64 installer only — the Electron
 * installer carried both architectures and electron-updater has no way to pick
 * between two, so an arm64 Electron install moves to the x64 app (which
 * Windows 11 on arm64 runs emulated) and stays there. Linux: the AppImage
 * only, the one Linux package electron-updater ever installed for this app.
 */
export function legacyFeedNames({ leg, version, archs }) {
  if (leg === "mac") {
    return [...archs.map((arch) => artifactName("zip", { version, arch })), ...archs.map((arch) => artifactName("dmg", { version, arch }))];
  }
  if (leg === "win") return [artifactName("nsis", { version, arch: "x64" })];
  if (leg === "linux-x64") return [artifactName("appimage", { version, arch: "x64" })];
  if (leg === "linux-arm64") return [artifactName("appimage", { version, arch: "arm64" })];
  return [];
}

/**
 * latest.json as tauri-plugin-updater reads it (the "static" format), written
 * with `stagingPercentage` FIRST when there is one. That placement is what lets
 * `desktop:rollout` add, change or remove the percentage as exactly one line
 * (`setStagingPercentageJson`), leaving every other byte — every URL and every
 * signature — as this function wrote it.
 *
 * @param {{ version: string, notes: string, pubDate: string, platforms: Record<string, { url: string, signature: string }>, stagingPercentage?: number | null }} input
 */
export function tauriFeedText({ version, notes, pubDate, platforms, stagingPercentage = null }) {
  const sorted = Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b)));
  const feed = {
    ...(stagingPercentage === null ? {} : { stagingPercentage }),
    version,
    notes,
    pub_date: pubDate,
    platforms: sorted,
  };
  return `${JSON.stringify(feed, null, 2)}\n`;
}

/**
 * Merge the legs' fragments into latest.json's platforms, with full download
 * URLs. Every fragment must be for the release's version, and no two legs may
 * answer one target.
 *
 * @param {{ version: string, base: string, fragments: { name: string, fragment: { version: string, platforms: Record<string, { file: string, signature: string }> } }[] }} input
 * @returns {{ platforms: Record<string, { url: string, signature: string }>, files: Map<string, string>, problems: string[] }}
 *   `files` maps each payload file name to its signature, for `tauriFeedProblems`.
 */
export function mergeUpdaterFragments({ version, base, fragments }) {
  const platforms = {};
  const files = new Map();
  const problems = [];
  for (const { name, fragment } of fragments) {
    if (fragment?.version !== version) {
      problems.push(`${name} is for version ${fragment?.version}, not ${version}.`);
      continue;
    }
    for (const [target, entry] of Object.entries(fragment.platforms ?? {})) {
      if (platforms[target]) {
        problems.push(`Two legs sign an update for ${target} (${name} is the second).`);
        continue;
      }
      if (typeof entry?.signature !== "string" || entry.signature.trim() === "" || typeof entry?.file !== "string") {
        problems.push(`${name}: ${target} has no file or no signature.`);
        continue;
      }
      platforms[target] = { url: `${base}${entry.file}`, signature: entry.signature.trim() };
      files.set(entry.file, entry.signature.trim());
    }
  }
  return { platforms, files, problems };
}

/**
 * Every payload latest.json names must be attached under that exact name, at
 * that release's download URL, or every installed app downloads a 404 and
 * reports an update error. The signature itself is checked against the file
 * where the build made it (`desktop-tauri.mjs` → `verifyMinisign`).
 *
 * @param {{ name: string, feed: { version?: string, platforms?: Record<string, { url: string, signature: string }> }, version: string, base: string, attached: Map<string, unknown> }} input
 * @returns {string[]} problems
 */
export function tauriFeedProblems({ name, feed, version, base, attached }) {
  const problems = [];
  if (feed?.version !== version) problems.push(`${name} says version ${feed?.version}, not ${version}.`);
  const entries = Object.entries(feed?.platforms ?? {});
  if (entries.length === 0) problems.push(`${name} lists no platforms.`);
  for (const [target, { url, signature }] of entries) {
    if (typeof url !== "string" || !url.startsWith(base)) {
      problems.push(`${name}: ${target} points at ${url}, outside ${base}.`);
      continue;
    }
    const file = decodeURIComponent(url.slice(base.length));
    if (!attached.has(file)) problems.push(`${name}: ${target} names ${file}, which is not attached.`);
    if (typeof signature !== "string" || signature.trim() === "") problems.push(`${name}: ${target} has no signature.`);
  }
  return problems;
}

/** Files that go to a store or stay a CI artifact, never onto the release page. */
const STORE_ONLY = /\.(pkg|appx|msix|snap)$/;

/**
 * What goes into the draft GitHub Release for a tag, from the legs the matrix
 * built (`desktop-<channel>-<mode>` artifacts).
 *
 * - An `-unsigned` file is never attached: a release page is where people
 *   download from, and no updater offers it. The leg's absence is a warning,
 *   so a person publishing the draft sees which platform has no download.
 * - Store packages (pkg, appx, snap) stay CI artifacts for a manual upload.
 * - Per-leg checksum files are replaced by one over what is attached, and the
 *   minisign `.sig` files live inside latest.json rather than beside it.
 * - A leg that updates itself (signed mac and win, every Linux leg) must bring
 *   BOTH feeds: its legacy `latest*.yml`, without which Electron installs never
 *   migrate, and its updater fragment, without which the Tauri installs it
 *   creates never update again. Nothing else would say so.
 *
 * @param {{ channel: string, mode: string, files: string[] }[]} legs
 * @returns {{ upload: string[], feeds: string[], fragments: string[], warnings: string[], problems: string[] }}
 */
export function releasePlan(legs) {
  const upload = [];
  const feeds = [];
  const fragments = [];
  const warnings = [];
  const problems = [];
  for (const leg of legs) {
    const feedFile = LEGACY_FEED_FILES[leg.channel];
    const fragmentFile = updaterFragmentName(leg.channel);
    const updates = feedFile !== undefined && (leg.channel.startsWith("linux") || leg.mode === "signed");
    if ((leg.channel === "mac" || leg.channel === "win") && leg.mode !== "signed") {
      warnings.push(`${leg.channel} was built unsigned: the draft has no ${leg.channel === "mac" ? "macOS" : "Windows"} download and no update for it.`);
    }
    for (const file of leg.files) {
      const name = file.split("/").pop();
      if (/-unsigned\./.test(name) || STORE_ONLY.test(name) || /^SHA256SUMS/.test(name) || name.endsWith(".sig")) continue;
      if (/^latest.*\.yml$/.test(name)) {
        if (updates && name === feedFile) feeds.push(file);
        continue;
      }
      if (/^updater-.*\.json$/.test(name)) {
        if (updates && name === fragmentFile) fragments.push(file);
        continue;
      }
      if (name === TAURI_FEED_FILE) continue;
      upload.push(file);
    }
    const has = (wanted) => leg.files.some((file) => file.split("/").pop() === wanted);
    if (updates && !has(feedFile)) {
      problems.push(`The ${leg.channel} leg has no ${feedFile}; Electron installs would never be offered this release.`);
    }
    if (updates && !has(fragmentFile)) {
      problems.push(
        `The ${leg.channel} leg has no ${fragmentFile}; the Tauri app it ships could never update itself (is TAURI_SIGNING_PRIVATE_KEY set?).`,
      );
    }
  }
  if (upload.length === 0) problems.push("Nothing to attach: every leg was unsigned, a store package, or empty.");
  return { upload, feeds, fragments, warnings, problems };
}

/**
 * Every file a legacy feed names must be attached, with the size and sha512
 * the feed states, or electron-updater downloads it, rejects the checksum and
 * reports an error to every installed app.
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

// ── The Electron installs being migrated ──────────────────────────────

/**
 * The newest release that is an Electron build. Every release after it is
 * Tauri, and every one of them still publishes the legacy feeds above.
 */
export const LAST_ELECTRON_RELEASE = "0.3.0";

/**
 * electron-builder's namespace for the NSIS GUID (app-builder-lib
 * NsisTarget.js, `ELECTRON_BUILDER_NS_UUID`). The Electron installer wrote its
 * uninstall entry under `UUID.v5(appId, this)`.
 */
export const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";

/** RFC 4122 version 5, which builder-util-runtime's `UUID.v5` is. */
export function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const bytes = Buffer.from(createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The registry keys a per-user Electron install of this app left (HKCU). */
export function electronUninstallKeys(appId = "com.ricoslabs.trackyourtime") {
  const guid = uuidV5(appId, ELECTRON_BUILDER_NS_UUID);
  return {
    guid,
    uninstall: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
    install: `Software\\${guid}`,
  };
}
