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
    // Never fall back to a keychain identity when the set names a certificate.
    next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
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

/** Which placeholders each manifest family needs, so one family renders alone. */
export const MANIFEST_FAMILIES = Object.freeze({
  homebrew: ["sha256_mac_arm64_dmg", "sha256_mac_x64_dmg"],
  winget: ["sha256_win_nsis"],
  flatpak: ["sha256_linux_x64_targz", "sha256_linux_arm64_targz", "sha256_icon_png"],
});

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
