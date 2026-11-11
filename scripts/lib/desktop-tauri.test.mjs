import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { UPDATER_ENDPOINT } from "./desktop-release.mjs";
import {
  archOfTarget,
  bundlerTargets,
  infoPlistFor,
  LINUX_NAME,
  LINUX_PACKAGE_DEPENDENCIES,
  msixVersion,
  parseMinisignPublicKey,
  platformOfTarget,
  RUST_TARGETS,
  tauriBuildArgs,
  tauriConfigFor,
  unpackedDirName,
  updaterFragment,
  verifyMinisign,
} from "./desktop-tauri.mjs";

const root = new URL("../../", import.meta.url).pathname;
const paths = {
  macEntitlements: "/r/build/entitlements.tauri.plist",
  masEntitlements: "/r/gen/entitlements.mas.plist",
  infoPlist: "/r/gen/Info.plist",
  assetCatalog: "/r/gen/icons/Assets.car",
  provisioningProfile: "/r/embedded.provisionprofile",
  nsisHooks: "/r/build/windows/installer-hooks.nsh",
  signWindows: "/r/scripts/desktop/sign-windows.ps1",
  desktopTemplate: "/r/build/linux/trackyourtime.desktop.hbs",
  preinstall: "/r/build/linux/preinstall.sh",
};
const signed = { mode: "signed" };
const unsigned = { mode: "unsigned" };
const feed = { feed: true };
const noFeed = { feed: false };

describe("tauriConfigFor — the update feed", () => {
  it("configures the updater, and the payloads, only for a build with a feed", () => {
    const config = tauriConfigFor({ channel: "mac", platform: "darwin", signing: signed, updater: feed, pubkey: " PUB \n", identity: "Developer ID Application: X (T)", paths });
    assert.deepEqual(config.plugins.updater, { pubkey: "PUB", endpoints: [UPDATER_ENDPOINT] });
    assert.equal(config.bundle.createUpdaterArtifacts, true);
  });

  it("removes the updater (null in the merge patch) everywhere else, which the app reads as no feed", () => {
    for (const [channel, platform, signing] of [
      ["mac", "darwin", unsigned],
      ["mas", "darwin", signed],
      ["win-store", "win32", { mode: "store" }],
      [null, "linux", unsigned],
    ]) {
      const config = tauriConfigFor({ channel, platform, signing, updater: noFeed, pubkey: "PUB", identity: "Apple Distribution: X (T)", paths });
      assert.strictEqual(config.plugins.updater, null, `${channel}`);
      assert.equal(config.bundle.createUpdaterArtifacts, false);
    }
  });

  it("refuses a feed without a public key", () => {
    assert.throws(() => tauriConfigFor({ channel: "linux", platform: "linux", signing: unsigned, updater: feed, pubkey: "", paths }), /public key/);
  });
});

describe("tauriConfigFor — macOS", () => {
  it("signs with the certificate's identity and the hardened runtime, and nothing from a keychain otherwise", () => {
    const mac = tauriConfigFor({ channel: "mac", platform: "darwin", signing: signed, updater: feed, pubkey: "P", identity: "Developer ID Application: X (T)", paths }).bundle.macOS;
    assert.equal(mac.signingIdentity, "Developer ID Application: X (T)");
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.entitlements, paths.macEntitlements);
    assert.deepEqual(mac.files, { "Resources/Assets.car": paths.assetCatalog });

    const local = tauriConfigFor({ channel: null, platform: "darwin", signing: unsigned, updater: noFeed, pubkey: null, paths }).bundle.macOS;
    assert.equal(local.signingIdentity, "-", "ad hoc, never an identity found in a keychain");
    assert.equal(local.hardenedRuntime, false);
    assert.throws(() => tauriConfigFor({ channel: "mac", platform: "darwin", signing: signed, updater: feed, pubkey: "P", paths }), /signing identity/);
  });

  it("builds the store app sandboxed, numbered, with its profile and without the hardened runtime", () => {
    const mas = tauriConfigFor({ channel: "mas", platform: "darwin", signing: signed, updater: noFeed, pubkey: null, identity: "Apple Distribution: X (T)", buildNumber: "4512301", paths }).bundle.macOS;
    assert.equal(mas.entitlements, paths.masEntitlements);
    assert.equal(mas.hardenedRuntime, false);
    assert.equal(mas.bundleVersion, "4512301");
    assert.equal(mas.files["embedded.provisionprofile"], paths.provisioningProfile);
    assert.throws(() => tauriConfigFor({ channel: "mas", platform: "darwin", signing: signed, updater: noFeed, pubkey: null, identity: "A", paths: { ...paths, provisioningProfile: null } }), /MAS_PROVISIONING_PROFILE/);
    assert.throws(() => tauriConfigFor({ channel: "mas", platform: "darwin", signing: unsigned, updater: noFeed, pubkey: null, buildNumber: "0.4.0", paths }), /DESKTOP_BUILD_NUMBER/);
  });

  it("names the compiled icon only when the catalog is in the bundle", () => {
    assert.match(infoPlistFor({ assetCatalog: "/x/Assets.car" }), /CFBundleIconName<\/key>\s*<string>AppIcon/);
    assert.doesNotMatch(infoPlistFor({ assetCatalog: null }), /CFBundleIconName/);
    assert.match(infoPlistFor({ assetCatalog: null }), /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it("the committed entitlements are the ones tauri.conf.json names", () => {
    const base = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    assert.equal(base.bundle.macOS.entitlements, "../../build/entitlements.tauri.plist");
    assert.equal(base.identifier, "com.ricoslabs.trackyourtime");
    assert.equal(base.version, "../../package.json", "the app's version is package.json's");
  });
});

describe("tauriConfigFor — Windows", () => {
  it("signs every file through the one script, only for a signed build", () => {
    const win = tauriConfigFor({ channel: "win", platform: "win32", signing: signed, updater: feed, pubkey: "P", paths }).bundle.windows;
    assert.deepEqual(win.signCommand, { cmd: "pwsh", args: ["-NoProfile", "-NonInteractive", "-File", paths.signWindows, "-FilePath", "%1"] });
    assert.equal(win.nsis.installerHooks, paths.nsisHooks);
    assert.equal(win.nsis.installMode, "currentUser");
    assert.strictEqual(tauriConfigFor({ channel: "win", platform: "win32", signing: unsigned, updater: noFeed, pubkey: null, paths }).bundle.windows.signCommand, null);
  });

  it("packs the MSIX version as four numbers", () => {
    assert.equal(msixVersion("0.4.0"), "0.4.0.0");
    assert.equal(msixVersion("1.2.0-rc.1"), "1.2.0.0");
    assert.throws(() => msixVersion("next"), /MSIX/);
  });
});

describe("tauriConfigFor — Linux", () => {
  it("declares every library the binary loads, including the dlopened ones", () => {
    const linux = tauriConfigFor({ channel: "linux", platform: "linux", signing: unsigned, updater: noFeed, pubkey: null, paths }).bundle.linux;
    assert.deepEqual(linux.deb.depends, [...LINUX_PACKAGE_DEPENDENCIES.deb.depends]);
    assert.deepEqual(linux.rpm.depends, [...LINUX_PACKAGE_DEPENDENCIES.rpm.depends]);
    // The tray and the idle time are dlopened: ldd never names them.
    assert.ok(linux.deb.depends.includes("libayatana-appindicator3-1"));
    assert.ok(linux.deb.depends.includes("libxss1"));
    assert.ok(linux.rpm.depends.includes("libayatana-appindicator-gtk3"));
    assert.ok(linux.rpm.depends.includes("libXScrnSaver"));
    assert.equal(linux.deb.preInstallScript, paths.preinstall);
    assert.equal(linux.rpm.desktopTemplate, paths.desktopTemplate);
  });

  it("keeps the package and executable names of the Electron packages", () => {
    const overlay = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.linux.conf.json"), "utf8"));
    assert.equal(overlay.productName, LINUX_NAME);
    assert.equal(overlay.mainBinaryName, LINUX_NAME);
    assert.equal(LINUX_NAME, "trackyourtime");
    const entry = readFileSync(join(root, "build/linux/trackyourtime.desktop.hbs"), "utf8");
    assert.match(entry, /^Name=Track Your Time$/m);
    assert.match(entry, /^Exec=\{\{exec\}\}$/m);
  });

  it("the pre-install script only ever removes the Electron package's alternative", () => {
    const script = readFileSync(join(root, "build/linux/preinstall.sh"), "utf8");
    assert.match(script, /update-alternatives --remove trackyourtime "\$old"/);
    assert.match(script, /^old='\/opt\/Track Your Time\/trackyourtime'$/m);
    assert.match(script, /^exit 0$/m);
  });
});

describe("build plumbing", () => {
  it("maps each architecture to its Rust target and back", () => {
    for (const [platform, targets] of Object.entries(RUST_TARGETS)) {
      for (const [arch, target] of Object.entries(targets)) {
        assert.equal(archOfTarget(target), arch);
        assert.equal(platformOfTarget(target), platform);
      }
    }
  });

  it("asks the bundler only for what the channel's files are made from", () => {
    assert.deepEqual(bundlerTargets({ channel: "mac", platform: "darwin", bundles: ["dmg", "zip"], dir: false }), ["app"]);
    assert.deepEqual(bundlerTargets({ channel: "win", platform: "win32", bundles: ["nsis"], dir: false }), ["nsis"]);
    assert.deepEqual(bundlerTargets({ channel: "win-store", platform: "win32", bundles: ["appx"], dir: false }), []);
    assert.deepEqual(bundlerTargets({ channel: "linux", platform: "linux", bundles: ["snap", "targz", "appimage"], dir: false }), ["deb", "appimage"]);
    assert.deepEqual(bundlerTargets({ channel: "linux", platform: "linux", bundles: [], dir: true }), []);
  });

  it("passes --locked to cargo in CI only, and --no-bundle for an unpacked app", () => {
    assert.deepEqual(tauriBuildArgs({ configPath: "c.json", target: "x86_64-unknown-linux-gnu", bundles: ["deb"], locked: true }), [
      "build", "--config", "c.json", "--target", "x86_64-unknown-linux-gnu", "--ci", "--bundles", "deb", "--", "--locked",
    ]);
    assert.deepEqual(tauriBuildArgs({ configPath: "c.json", target: "aarch64-pc-windows-msvc", bundles: [], features: ["mas"], runner: "cargo-xwin" }), [
      "build", "--config", "c.json", "--target", "aarch64-pc-windows-msvc", "--ci", "--no-bundle", "--features", "mas", "--runner", "cargo-xwin",
    ]);
  });

  it("names unpacked apps the way the VM drop and the smoke tests look for them", () => {
    assert.equal(unpackedDirName({ platform: "darwin", arch: "arm64", channel: "mac" }), "mac-arm64");
    assert.equal(unpackedDirName({ platform: "darwin", arch: "universal", channel: "mas" }), "mas-universal");
    assert.equal(unpackedDirName({ platform: "win32", arch: "arm64", channel: "win" }), "win-arm64-unpacked");
    assert.equal(unpackedDirName({ platform: "linux", arch: "x64", channel: "linux" }), "linux-unpacked");
    assert.equal(unpackedDirName({ platform: "linux", arch: "arm64", channel: "linux" }), "linux-arm64-unpacked");
  });

  it("writes one fragment entry per latest.json key", () => {
    const fragment = updaterFragment({ version: "0.4.0", entries: [{ targets: ["a", "b"], file: "f", signature: " s\n" }] });
    assert.deepEqual(fragment.platforms, { a: { file: "f", signature: "s" }, b: { file: "f", signature: "s" } });
  });
});

describe("verifyMinisign", () => {
  // A signature `tauri signer sign` (tauri-cli 2.12.4) made over payload.bin
  // with a throwaway key, whose private half was deleted afterwards. These are
  // not the release's update key (build/updater.pub).
  const fixtures = join(root, "scripts/fixtures/updater");
  const publicKey = readFileSync(join(fixtures, "fixture.pub"), "utf8");
  const signature = readFileSync(join(fixtures, "payload.bin.sig"), "utf8");
  const data = readFileSync(join(fixtures, "payload.bin"));

  it("accepts what tauri-plugin-updater accepts", () => {
    assert.deepEqual(verifyMinisign({ publicKey, signature, data }), { ok: true });
    assert.equal(parseMinisignPublicKey(publicKey).keyId.length, 16);
  });

  it("rejects another file, another key, a tampered trusted comment and garbage", () => {
    assert.match(verifyMinisign({ publicKey, signature, data: Buffer.concat([data, Buffer.from("!")]) }).reason, /does not match the file/);

    const lines = Buffer.from(publicKey, "base64").toString("utf8").split("\n");
    const raw = Buffer.from(lines[1], "base64");
    raw[2] ^= 0xff; // another key id
    const otherKey = Buffer.from(`${lines[0]}\n${raw.toString("base64")}\n`).toString("base64");
    assert.match(verifyMinisign({ publicKey: otherKey, signature, data }).reason, /configured key/);

    const sig = Buffer.from(signature, "base64").toString("utf8").replace("timestamp:", "timestamp:9");
    assert.match(verifyMinisign({ publicKey, signature: Buffer.from(sig).toString("base64"), data }).reason, /trusted comment/);

    assert.equal(verifyMinisign({ publicKey: "nope", signature, data }).ok, false);
    assert.equal(verifyMinisign({ publicKey, signature: "", data }).ok, false);
  });
});
