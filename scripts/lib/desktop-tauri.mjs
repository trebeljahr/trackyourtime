/*
 * The Tauri half of the desktop build, as rules with no build in them:
 * which config a channel packages with, what the bundler writes and where,
 * which Linux libraries the packages must declare, and how an update
 * signature is checked. `scripts/build-desktop.mjs` does the file work;
 * `desktop-tauri.test.mjs` pins every rule here.
 *
 * The committed `desktop/src-tauri/tauri.conf.json` is what every cargo build
 * reads (dev, the e2e harness, `cargo check`); `tauri.linux.conf.json` beside
 * it renames the Linux package and binary. A release adds the generated
 * config below on top (`tauri build --config <file>`, a JSON merge patch), so
 * whatever differs per channel — signing identity, entitlements, the update
 * feed, the Windows installer hooks, the Linux dependencies — is decided here
 * and nowhere else.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

import { UPDATER_ENDPOINT, UPDATE_FEED } from "./desktop-release.mjs";

export const APP_ID = "com.ricoslabs.trackyourtime";
export const PRODUCT_NAME = "Track Your Time";
/**
 * The Linux package and executable name: what the Electron deb, rpm and
 * AppImage were called, so `apt install ./trackyourtime_<v>_amd64.deb`
 * upgrades the Electron package in place rather than installing a second app
 * beside it. `tauri.linux.conf.json` sets it as productName and
 * mainBinaryName, because the Tauri bundler derives the deb and rpm package
 * name from productName.
 */
export const LINUX_NAME = "trackyourtime";
export const TAURI_DIR = "desktop/src-tauri";
/**
 * The app's smoke mode (desktop/src-tauri/src/problems.rs → SMOKE_ENV, release
 * builds too): given a path, the app loads, waits for its page, writes
 * `{ ok, href, title, bridge, platform, bodyText, problems }` there and exits,
 * 0 on ok. What the Linux smoke tests judge a package by, since a WebKitGTK
 * app has no CDP to drive.
 */
export const SMOKE_REPORT_ENV = "TRACKYOURTIME_SMOKE_REPORT";
export const CARGO_MANIFEST = `${TAURI_DIR}/Cargo.toml`;

/** The Rust target triple for each `--arch` a host builds. */
export const RUST_TARGETS = Object.freeze({
  darwin: Object.freeze({ arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin", universal: "universal-apple-darwin" }),
  win32: Object.freeze({ x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" }),
  linux: Object.freeze({ x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" }),
});

/** This repo's word for a Rust target's architecture. */
export function archOfTarget(target) {
  if (target === "universal-apple-darwin") return "universal";
  if (/^aarch64-/.test(target)) return "arm64";
  if (/^x86_64-/.test(target)) return "x64";
  throw new Error(`Unknown Rust target ${target}.`);
}

/** The OS a Rust target builds for, in Node's spelling. */
export function platformOfTarget(target) {
  if (/-apple-darwin$/.test(target)) return "darwin";
  if (/-windows-/.test(target)) return "win32";
  if (/-linux-/.test(target)) return "linux";
  throw new Error(`Unknown Rust target ${target}.`);
}

/**
 * What the Linux packages must declare, because `apt-get` and `dnf` install
 * nothing else (`pnpm test:desktop:packages` installs each package in an
 * image with no desktop library at all, which is how electron-builder's
 * missing libgbm and ALSA were found). The list is from what the binary links
 * and what it loads at run time, read off `desktop/src-tauri/Cargo.lock`:
 *
 *   - WebKitGTK 4.1 and GTK 3: wry and tao link both (DT_NEEDED).
 *   - libdbus-1: the `dbus` crate links it (idle detection, the Secret Service
 *     through dbus-secret-service, tao's own use).
 *   - Ayatana AppIndicator: the tray. libappindicator-sys DLOPENS it, so `ldd`
 *     never names it and the app would start with no tray icon and no error.
 *   - libXss: x11-dl dlopens it for the idle time (`src-tauri/src/idle.rs`);
 *     without it the idle prompt never fires.
 *
 * Recommended, not required: `xprop`, which desktop activity capture runs
 * (`tyt_activity::source_linux`) and which reports itself unavailable without.
 *
 * Tauri's own defaults are repeated rather than relied on: a dependency that
 * is only there because a default happens to add it is one the next bundler
 * release drops.
 */
export const LINUX_PACKAGE_DEPENDENCIES = Object.freeze({
  deb: Object.freeze({
    depends: Object.freeze(["libwebkit2gtk-4.1-0", "libgtk-3-0", "libayatana-appindicator3-1", "libdbus-1-3", "libxss1"]),
    recommends: Object.freeze(["x11-utils"]),
  }),
  rpm: Object.freeze({
    depends: Object.freeze(["webkit2gtk4.1", "gtk3", "libayatana-appindicator-gtk3", "dbus-libs", "libXScrnSaver"]),
    recommends: Object.freeze(["xprop"]),
  }),
});

/**
 * The config merged over tauri.conf.json for one packaging run.
 *
 * @param {{
 *   channel: "mac" | "mas" | "win" | "win-store" | "linux" | null,
 *   platform: string,
 *   signing: { mode: "signed" | "unsigned" | "store" },
 *   updater: { feed: boolean },
 *   pubkey: string | null,
 *   identity?: string | null,
 *   buildNumber?: string | null,
 *   paths: {
 *     macEntitlements: string, masEntitlements: string, infoPlist: string, assetCatalog: string | null,
 *     provisioningProfile: string | null, nsisHooks: string, signWindows: string,
 *     desktopTemplate: string, preinstall: string,
 *   },
 * }} input
 */
export function tauriConfigFor({ channel, platform, signing, updater, pubkey, identity = null, buildNumber = null, paths }) {
  const signed = signing.mode === "signed";
  const config = {
    bundle: {
      // Only a build with a feed writes and signs update payloads; without the
      // key, `tauri build` would refuse anyway.
      createUpdaterArtifacts: updater.feed,
    },
    // `null` removes the key in a JSON merge patch: a build without a feed has
    // no updater config even if tauri.conf.json ever grows one, which is what
    // the app reads as "no-feed" (`tyt_model::updater_model::updater_policy`).
    plugins: { updater: updater.feed ? { pubkey: requirePubkey(pubkey), endpoints: [UPDATER_ENDPOINT] } : null },
  };

  if (platform === "darwin") {
    const mas = channel === "mas";
    if (signed && !identity) throw new Error("A signed macOS build needs the signing identity from its certificate.");
    if (mas && signed && !paths.provisioningProfile) throw new Error("A signed Mac App Store build needs MAS_PROVISIONING_PROFILE.");
    if (mas && buildNumber !== null && !/^[1-9]\d{0,8}$/.test(String(buildNumber))) {
      throw new Error(`DESKTOP_BUILD_NUMBER must be a positive whole number, got ${buildNumber}.`);
    }
    const files = {};
    // macOS 26 and App Store Connect read the compiled Icon Composer icon
    // (CFBundleIconName → Assets.car); older macOS reads icon.icns, which the
    // bundler writes from `bundle.icon`. Both are in the bundle.
    if (paths.assetCatalog) files["Resources/Assets.car"] = paths.assetCatalog;
    if (mas && paths.provisioningProfile) files["embedded.provisionprofile"] = paths.provisioningProfile;
    config.bundle.macOS = {
      // "-" is an ad-hoc signature, which Apple Silicon needs to run the app at
      // all. Never an identity found in a keychain: signing only ever comes
      // from a channel's complete secret set.
      signingIdentity: signed ? identity : "-",
      // Only with a real identity, and never for the store, which re-signs:
      // the rule electron-builder's config kept, kept here.
      hardenedRuntime: signed && !mas,
      entitlements: mas ? paths.masEntitlements : paths.macEntitlements,
      infoPlist: paths.infoPlist,
      files,
      ...(mas && buildNumber !== null ? { bundleVersion: String(buildNumber) } : {}),
    };
  }

  if (platform === "win32") {
    config.bundle.windows = {
      // Signs the app, the uninstaller and the installer, each as the bundler
      // writes it, so the signature the updater's minisign key then covers is
      // already on the file.
      signCommand: signed ? { cmd: "pwsh", args: ["-NoProfile", "-NonInteractive", "-File", paths.signWindows, "-FilePath", "%1"] } : null,
      nsis: {
        installMode: "currentUser",
        // Moves an Electron install out of the way before this one lands
        // (build/windows/installer-hooks.nsh).
        installerHooks: paths.nsisHooks,
      },
    };
  }

  if (platform === "linux") {
    const { deb, rpm } = LINUX_PACKAGE_DEPENDENCIES;
    config.bundle.linux = {
      deb: {
        depends: [...deb.depends],
        recommends: [...deb.recommends],
        desktopTemplate: paths.desktopTemplate,
        preInstallScript: paths.preinstall,
      },
      rpm: {
        depends: [...rpm.depends],
        recommends: [...rpm.recommends],
        desktopTemplate: paths.desktopTemplate,
        preInstallScript: paths.preinstall,
      },
      appimage: { bundleMediaFramework: false },
    };
  }

  return config;
}

function requirePubkey(pubkey) {
  if (typeof pubkey !== "string" || pubkey.trim() === "") throw new Error("An update feed needs the public key (build/updater.pub).");
  return pubkey.trim();
}

/**
 * Extra Info.plist keys, merged by the bundler (`bundle.macOS.infoPlist`).
 *
 * `ITSAppUsesNonExemptEncryption` false: HTTPS and the OS's own crypto only,
 * exempt from export documentation; App Store Connect asks on every upload
 * without it. `CFBundleIconName` names the image set in Assets.car, and only
 * when the catalog is in the bundle — naming one that is not there gives a
 * blank icon on macOS 26.
 */
export function infoPlistFor({ assetCatalog }) {
  const icon = assetCatalog
    ? `
    <key>CFBundleIconName</key>
    <string>AppIcon</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/build-desktop.mjs from scripts/lib/desktop-tauri.mjs. Do not edit. -->
<plist version="1.0">
  <dict>
    <key>ITSAppUsesNonExemptEncryption</key>
    <false/>${icon}
  </dict>
</plist>
`;
}

/**
 * `tauri build` arguments. `--bundles app` on macOS gives the .app that the
 * dmg, the zip and the updater archive are then made from by hand (the
 * bundler's own dmg step scripts Finder, which opens windows on the machine it
 * runs on). Everything else names the bundler's own targets; `--no-bundle`
 * leaves the executable alone, which is all an unpacked Windows or Linux app
 * is when the export is inside the binary.
 */
export function tauriBuildArgs({ configPath, target, bundles, features = [], runner = null, locked = false }) {
  const args = ["build", "--config", configPath, "--target", target, "--ci"];
  if (bundles.length) args.push("--bundles", bundles.join(","));
  else args.push("--no-bundle");
  if (features.length) args.push("--features", features.join(","));
  if (runner) args.push("--runner", runner);
  // Cargo.lock is committed; CI never resolves dependencies anew, so a release
  // is built from exactly the versions a reviewer saw.
  if (locked) args.push("--", "--locked");
  return args;
}

/**
 * Which Tauri bundler targets a channel's artifacts come from.
 *
 * @param {{ channel: string, platform: string, bundles: string[], dir: boolean }} input
 *   `bundles` in this repo's words (`dmg`, `zip`, `nsis`, `appimage`, `targz`, …)
 */
export function bundlerTargets({ channel, platform, bundles, dir }) {
  if (platform === "darwin") return ["app"];
  if (dir || channel === "win-store") return [];
  if (platform === "win32") return bundles.includes("nsis") ? ["nsis"] : [];
  // A snap is made from the deb, and a tar.gz from the bare executable.
  const linux = new Set();
  for (const bundle of bundles) {
    if (bundle === "appimage" || bundle === "deb" || bundle === "rpm") linux.add(bundle);
    if (bundle === "snap") linux.add("deb");
  }
  return ["deb", "rpm", "appimage"].filter((b) => linux.has(b));
}

/** The executable name `tauri build` leaves in `target/<triple>/release/`. */
export function mainBinaryFor(platform) {
  if (platform === "win32") return `${PRODUCT_NAME}.exe`;
  if (platform === "linux") return LINUX_NAME;
  return PRODUCT_NAME;
}

/**
 * Where the bundler writes each output, relative to `target/<triple>/release/bundle`,
 * as a directory and a file-name test. Tests rather than names because the
 * bundler's own names (`Track Your Time_0.4.0_x64-setup.exe`,
 * `trackyourtime-0.4.0-1.x86_64.rpm`) are its business; build-desktop.mjs
 * requires exactly one match and renames it to `artifactName`.
 */
export const BUNDLER_OUTPUTS = Object.freeze({
  app: Object.freeze({ dir: "macos", match: (name) => name === `${PRODUCT_NAME}.app` }),
  macUpdater: Object.freeze({ dir: "macos", match: (name) => name === `${PRODUCT_NAME}.app.tar.gz` }),
  nsis: Object.freeze({ dir: "nsis", match: (name) => /-setup\.exe$/.test(name) }),
  deb: Object.freeze({ dir: "deb", match: (name) => /\.deb$/.test(name) }),
  rpm: Object.freeze({ dir: "rpm", match: (name) => /\.rpm$/.test(name) }),
  appimage: Object.freeze({ dir: "appimage", match: (name) => /\.AppImage$/.test(name) }),
});

/** Where unpacked apps go (`--dir`), named the way electron-builder named them. */
export function unpackedDirName({ platform, arch, channel }) {
  if (platform === "darwin") return `${channel === "mas" ? "mas" : "mac"}-${arch}`;
  if (platform === "win32") return arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`;
  return arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
}

/**
 * The MSIX version: four numbers, the last 0 (the Store reserves it). A
 * prerelease part has no place in it, so `1.2.0-rc.1` packs as `1.2.0.0`.
 */
export function msixVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`${version} is not a version an MSIX can carry.`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

/** The release fragment one leg writes for latest.json (`updaterFragmentName`). */
export function updaterFragment({ version, entries }) {
  const platforms = {};
  for (const { targets, file, signature } of entries) {
    for (const target of targets) platforms[target] = { file, signature: signature.trim() };
  }
  return { version, repository: `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`, platforms };
}

// ── minisign ──────────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The lines of a base64-wrapped minisign file, as `tauri signer` writes them. */
function unwrap(b64, what) {
  const text = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`The ${what} is not a base64 minisign file.`);
  return lines;
}

/** The key id and raw Ed25519 public key in `build/updater.pub`'s format. */
export function parseMinisignPublicKey(b64) {
  const bytes = Buffer.from(unwrap(b64, "public key")[1] ?? "", "base64");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("The public key is not an Ed25519 minisign key.");
  return { keyId: bytes.subarray(2, 10).toString("hex"), key: bytes.subarray(10) };
}

/**
 * Whether `signature` (a `.sig` file's content, base64 as `tauri signer sign`
 * writes it) is a valid signature of `data` by `publicKey` — the check
 * tauri-plugin-updater makes on every installed app before it installs
 * anything. Run on the build's own output, so a release whose payloads were
 * signed with a key that does not match `build/updater.pub` fails in CI rather
 * than in every installed app.
 *
 * Both halves are checked: the signature over the file (prehashed with
 * BLAKE2b-512 for the `ED` algorithm Tauri uses) and the global signature over
 * it and its trusted comment.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyMinisign({ publicKey, signature, data }) {
  let pub;
  let lines;
  try {
    pub = parseMinisignPublicKey(publicKey);
    lines = unwrap(signature, "signature");
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || !trusted.startsWith("trusted comment: ") || global.length !== 64) {
    return { ok: false, reason: "The signature file is malformed." };
  }
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") return { ok: false, reason: `Unknown signature algorithm ${algorithm}.` };
  const keyId = sig.subarray(2, 10).toString("hex");
  if (keyId !== pub.keyId) return { ok: false, reason: `Signed by key ${keyId}, but the configured key is ${pub.keyId}.` };
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub.key]), format: "der", type: "spki" });
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10))) return { ok: false, reason: "The signature does not match the file." };
  const comment = Buffer.from(trusted.slice("trusted comment: ".length), "utf8");
  if (!verify(null, Buffer.concat([sig.subarray(10), comment]), key, global)) {
    return { ok: false, reason: "The trusted comment's signature does not match." };
  }
  return { ok: true };
}
