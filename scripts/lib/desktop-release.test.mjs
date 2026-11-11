import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import yaml from "js-yaml";

import {
  ALL_SIGNING_VARS,
  artifactName,
  artifactPatterns,
  electronUninstallKeys,
  expandArtifactName,
  feedDigest,
  feedProblems,
  isPrereleaseTag,
  legacyFeedNames,
  legacyFeedText,
  MANIFEST_FAMILIES,
  manifestArtifacts,
  manifestFamilyPlan,
  masEntitlementsPlist,
  mergeUpdaterFragments,
  releaseDownloadBase,
  releasePlan,
  renderManifestTemplate,
  REPO_FILE_CHECKSUMS,
  resolveSigning,
  resolveUpdater,
  SIGNING_CREDENTIAL_VARS,
  SIGNING_SETS,
  SNAP_CREDENTIALS_VAR,
  SNAP_NAME,
  SNAP_PRERELEASE_CHANNEL,
  SNAP_RELEASE_CHANNEL,
  snapPublishPlan,
  tagMismatch,
  targetChannelProblem,
  TAURI_SELF_SIGNING_VARS,
  tauriEnvFor,
  tauriFeedProblems,
  tauriFeedText,
  UPDATER_ENDPOINT,
  UPDATER_KEY_PASSWORD_VAR,
  UPDATER_KEY_VAR,
  updaterTargets,
  uuidV5,
  WINDOWS_STORE_IDENTITY,
  windowsStoreIdentityState,
  WINGET_PACKAGE_IDENTIFIER,
  wingetManifestPath,
  wingetPrTitle,
} from "./desktop-release.mjs";

const root = new URL("../../", import.meta.url).pathname;
const all = (names, value = "x") => Object.fromEntries(names.map((n) => [n, value]));

describe("resolveSigning", () => {
  it("builds unsigned when no secret is set, and treats empty strings as unset", () => {
    assert.deepEqual(resolveSigning("mac", {}), { mode: "unsigned" });
    assert.deepEqual(resolveSigning("mac", all(SIGNING_SETS.mac[0], "")), { mode: "unsigned" });
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[1], "  ")), { mode: "unsigned" });
  });

  it("signs with a complete set", () => {
    assert.equal(resolveSigning("mac", all(SIGNING_SETS.mac[0])).mode, "signed");
    assert.equal(resolveSigning("mas", all(SIGNING_SETS.mas[0])).mode, "signed");
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[0])).set, SIGNING_SETS.win[0]);
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[1])).set, SIGNING_SETS.win[1]);
  });

  it("refuses a partial set and names what is missing", () => {
    assert.throws(() => resolveSigning("mac", { CSC_LINK: "x", CSC_KEY_PASSWORD: "y" }), /Missing: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER/);
    assert.throws(() => resolveSigning("mas", { MAS_PROVISIONING_PROFILE: "p" }), /incomplete/);
    assert.throws(() => resolveSigning("win", { AZURE_TENANT_ID: "t" }), /AZURE_CLIENT_ID/);
  });

  it("does not start signing from the credentials the iOS release shares", () => {
    assert.deepEqual(resolveSigning("mac", { APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i", APPLE_API_ISSUER: "s" }), { mode: "unsigned" });
    assert.deepEqual(resolveSigning("mas", { APPLE_TEAM_ID: "ABCDE12345" }), { mode: "unsigned" });
    assert.throws(() => resolveSigning("mas", { CSC_LINK: "x", CSC_KEY_PASSWORD: "y", APPLE_TEAM_ID: "T" }), /Missing: MAS_PROVISIONING_PROFILE/);
  });

  it("refuses two complete Windows configurations", () => {
    assert.throws(() => resolveSigning("win", { ...all(SIGNING_SETS.win[0]), ...all(SIGNING_SETS.win[1]) }), /Two complete/);
  });

  it("refuses a partial set even when another set is complete", () => {
    assert.throws(() => resolveSigning("win", { ...all(SIGNING_SETS.win[0]), AZURE_TENANT_ID: "t" }), /incomplete/);
  });

  it("needs the whole Store identity and ignores signing secrets there", () => {
    assert.deepEqual(resolveSigning("win-store", { ...all(WINDOWS_STORE_IDENTITY), ...all(SIGNING_SETS.win[0]) }), { mode: "store" });
    assert.throws(() => resolveSigning("win-store", { WINDOWS_STORE_IDENTITY_NAME: "n" }), /WINDOWS_STORE_PUBLISHER, WINDOWS_STORE_PUBLISHER_DISPLAY_NAME/);
  });

  it("has nothing to sign on Linux", () => {
    assert.deepEqual(resolveSigning("linux", { CSC_LINK: "x" }), { mode: "unsigned" });
  });

  it("rejects an unknown channel", () => {
    assert.throws(() => resolveSigning("electron", {}), /Unknown desktop channel/);
  });
});

describe("resolveUpdater", () => {
  const signed = { mode: "signed" };
  const unsigned = { mode: "unsigned" };
  const key = { [UPDATER_KEY_VAR]: "secret" };

  it("gives a signed direct download a feed, and refuses one without the update key", () => {
    for (const channel of ["mac", "win"]) {
      assert.equal(resolveUpdater({ channel, signing: signed, env: key, pubkey: "pub" }).feed, true);
      assert.throws(() => resolveUpdater({ channel, signing: signed, env: {}, pubkey: "pub" }), /must be able to update itself/);
    }
  });

  it("never gives an -unsigned build a feed, even with the key in the shell", () => {
    for (const channel of ["mac", "win"]) {
      assert.equal(resolveUpdater({ channel, signing: unsigned, env: key, pubkey: "pub" }).feed, false);
    }
  });

  it("gives Linux a feed whenever the key is there", () => {
    assert.equal(resolveUpdater({ channel: "linux", signing: unsigned, env: key, pubkey: "pub" }).feed, true);
    assert.equal(resolveUpdater({ channel: "linux", signing: unsigned, env: {}, pubkey: "pub" }).feed, false);
    assert.equal(resolveUpdater({ channel: "linux", signing: unsigned, env: {}, pubkey: null }).feed, false);
  });

  it("never gives a store build or a local build a feed", () => {
    assert.equal(resolveUpdater({ channel: "mas", signing: signed, env: key, pubkey: "pub" }).feed, false);
    assert.equal(resolveUpdater({ channel: "win-store", signing: { mode: "store" }, env: key, pubkey: "pub" }).feed, false);
    assert.equal(resolveUpdater({ channel: null, signing: unsigned, env: key, pubkey: "pub" }).feed, false);
  });

  it("refuses a key without the committed public key, which every app would reject updates against", () => {
    assert.throws(() => resolveUpdater({ channel: "linux", signing: unsigned, env: key, pubkey: null }), /build\/updater\.pub/);
    assert.throws(() => resolveUpdater({ channel: "mac", signing: signed, env: key, pubkey: " " }), /build\/updater\.pub/);
  });
});

describe("tauriEnvFor", () => {
  it("never hands the Tauri CLI what it would sign or notarize with on its own", () => {
    // APPLE_API_KEY is the .p8's PATH here and the key ID to the Tauri CLI.
    const env = tauriEnvFor({ env: { ...all(TAURI_SELF_SIGNING_VARS), PATH: "/bin" }, signing: { mode: "signed" }, updater: { feed: true } });
    for (const name of TAURI_SELF_SIGNING_VARS) assert.equal(env[name], undefined, name);
    assert.equal(env.PATH, "/bin");
  });

  it("strips every credential from an unsigned build, and the update key from one without a feed", () => {
    const env = tauriEnvFor({
      env: { ...all(SIGNING_CREDENTIAL_VARS), [UPDATER_KEY_VAR]: "k", [UPDATER_KEY_PASSWORD_VAR]: "p" },
      signing: { mode: "unsigned" },
      updater: { feed: false },
    });
    for (const name of [...SIGNING_CREDENTIAL_VARS, UPDATER_KEY_VAR, UPDATER_KEY_PASSWORD_VAR]) assert.equal(env[name], undefined, name);
  });

  it("keeps the Windows signing set for the sign command of a signed build, and the update key with a feed", () => {
    const env = tauriEnvFor({ env: { ...all(SIGNING_SETS.win[1]), [UPDATER_KEY_VAR]: "k" }, signing: { mode: "signed" }, updater: { feed: true } });
    for (const name of SIGNING_SETS.win[1]) assert.equal(env[name], "x", name);
    assert.equal(env[UPDATER_KEY_VAR], "k");
  });

  it("strips every signing variable from a Store package build", () => {
    const env = tauriEnvFor({ env: all(ALL_SIGNING_VARS), signing: { mode: "store" }, updater: { feed: false } });
    for (const name of ALL_SIGNING_VARS) assert.equal(env[name], undefined, name);
  });
});

describe("windowsStoreIdentityState", () => {
  it("tells absent from partial, so only absent is skipped", () => {
    assert.equal(windowsStoreIdentityState({}), "absent");
    assert.equal(windowsStoreIdentityState(all(WINDOWS_STORE_IDENTITY, "")), "absent");
    assert.equal(windowsStoreIdentityState({ WINDOWS_STORE_PUBLISHER: "CN=x" }), "partial");
    assert.equal(windowsStoreIdentityState(all(WINDOWS_STORE_IDENTITY)), "complete");
  });
});

describe("targetChannelProblem", () => {
  it("refuses an AppX outside the win-store channel", () => {
    assert.match(targetChannelProblem(null, ["appx"], "win32"), /--channel win-store/);
    assert.match(targetChannelProblem("win", ["nsis", "appx"], "win32"), /--channel win-store/);
  });

  it("refuses anything but an AppX in the win-store channel, which names nothing -unsigned", () => {
    assert.match(targetChannelProblem("win-store", ["nsis"], "win32"), /AppX only/);
    assert.match(targetChannelProblem("win-store", ["appx", "nsis"], "win32"), /AppX only/);
    assert.match(targetChannelProblem("win-store", [], "win32"), /AppX only/);
  });

  it("refuses a bundle the channel does not make, and a channel on another OS", () => {
    assert.match(targetChannelProblem("mac", ["dmg", "nsis"], "darwin"), /does not build nsis/);
    assert.match(targetChannelProblem("linux", ["appimage"], "darwin"), /builds on linux/);
  });

  it("accepts the workflow's own invocations", () => {
    assert.equal(targetChannelProblem("win-store", ["appx"], "win32"), null);
    assert.equal(targetChannelProblem("win", ["nsis"], "win32"), null);
    assert.equal(targetChannelProblem("mac", ["dmg", "zip"], "darwin"), null);
    assert.equal(targetChannelProblem("mas", ["pkg"], "darwin"), null);
    assert.equal(targetChannelProblem("linux", ["appimage", "deb", "rpm", "targz", "snap"], "linux"), null);
    assert.equal(targetChannelProblem(null, ["dmg", "zip"], "darwin"), null);
  });
});

describe("artifact names", () => {
  it("are the names the Electron releases used (v0.3.0's assets)", () => {
    const v030 = new Set([
      "TrackYourTime-0.3.0-linux-arm64.AppImage",
      "TrackYourTime-0.3.0-linux-arm64.tar.gz",
      "TrackYourTime-0.3.0-linux-x64.tar.gz",
      "TrackYourTime-0.3.0-linux-x86_64.AppImage",
      "TrackYourTime-0.3.0-mac-arm64.dmg",
      "TrackYourTime-0.3.0-mac-arm64.zip",
      "TrackYourTime-0.3.0-mac-x64.dmg",
      "TrackYourTime-0.3.0-mac-x64.zip",
      "trackyourtime-0.3.0.aarch64.rpm",
      "trackyourtime-0.3.0.x86_64.rpm",
      "TrackYourTime-Setup-0.3.0.exe",
      "trackyourtime_0.3.0_amd64.deb",
      "trackyourtime_0.3.0_arm64.deb",
    ]);
    const version = "0.3.0";
    const names = [
      ...["arm64", "x64"].flatMap((arch) => ["dmg", "zip", "appimage", "targz", "deb", "rpm"].map((kind) => artifactName(kind, { version, arch }))),
      artifactName("nsis", { version, arch: "x64" }),
    ];
    for (const name of names) assert.ok(v030.has(name), `${name} is not a v0.3.0 asset name`);
    assert.equal(names.length, v030.size);
  });

  it("names the new files beside them", () => {
    assert.equal(artifactName("nsis", { version: "0.4.0", arch: "arm64" }), "TrackYourTime-Setup-0.4.0-arm64.exe");
    assert.equal(artifactName("macUpdater", { version: "0.4.0", arch: "arm64" }), "TrackYourTime-0.4.0-mac-arm64.app.tar.gz");
    assert.equal(artifactName("mas", { version: "0.4.0", arch: "universal" }), "TrackYourTime-0.4.0-mas-universal.pkg");
    assert.equal(artifactName("snap", { version: "0.4.0", arch: "arm64" }), "trackyourtime_0.4.0_arm64.snap");
    assert.equal(artifactName("appx", { version: "0.4.0", arch: "x64" }), "TrackYourTime-0.4.0-x64-store.appx");
  });

  it("says -unsigned in every name a person might download", () => {
    for (const kind of ["dmg", "zip", "macUpdater", "mas"]) assert.match(artifactName(kind, { version: "1", arch: "arm64", unsigned: true }), /-unsigned\./, kind);
    assert.equal(artifactName("nsis", { version: "1", arch: "arm64", unsigned: true }), "TrackYourTime-Setup-1-arm64-unsigned.exe");
    assert.doesNotMatch(artifactPatterns({ unsigned: false }).dmg, /unsigned/);
  });

  it("refuses a missing placeholder and an unknown kind", () => {
    assert.throws(() => expandArtifactName(artifactPatterns({ unsigned: false }).dmg, { version: "0.1.0" }), /No value for \$\{arch\}/);
    assert.throws(() => artifactName("blockmap", { version: "1", arch: "x64" }), /Unknown artifact kind/);
  });
});

describe("tagMismatch", () => {
  it("only checks tag runs", () => {
    assert.equal(tagMismatch({ refType: "branch", refName: "main", version: "0.1.0" }), null);
    assert.equal(tagMismatch({ refType: "tag", refName: "v0.1.0", version: "0.1.0" }), null);
    assert.match(tagMismatch({ refType: "tag", refName: "v0.2.0", version: "0.1.0" }), /expected v0.1.0/);
  });
});

describe("masEntitlementsPlist", () => {
  it("names the app and the team the provisioning profile names", () => {
    const plist = masEntitlementsPlist({ teamId: "ABCDE12345", appId: "com.ricoslabs.trackyourtime" });
    assert.match(plist, /application-identifier<\/key>\s*<string>ABCDE12345\.com\.ricoslabs\.trackyourtime<\/string>/);
    assert.match(plist, /team-identifier<\/key>\s*<string>ABCDE12345<\/string>/);
    assert.match(plist, /com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
    assert.match(plist, /com\.apple\.security\.network\.client<\/key>\s*<true\/>/);
  });

  it("asks for nothing the app does not use, JIT above all", () => {
    const plist = masEntitlementsPlist({ teamId: "ABCDE12345", appId: "a.b" });
    for (const unwanted of [/allow-jit/, /unsigned-executable-memory/, /application-groups/, /camera/, /location/, /apple-events/]) {
      assert.doesNotMatch(plist, unwanted);
    }
  });

  it("leaves the identity out rather than guessing a team", () => {
    assert.doesNotMatch(masEntitlementsPlist({ teamId: "", appId: "a.b" }), /identifier/);
  });

  it("the Developer ID build asks for no exception at all", () => {
    const plist = readFileSync(join(root, "build/entitlements.tauri.plist"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    assert.match(plist, /<dict\/>/);
  });
});

describe("manifests", () => {
  it("point at the signed file names only", () => {
    const files = manifestArtifacts("1.2.3");
    assert.equal(files.sha256_mac_arm64_dmg, "TrackYourTime-1.2.3-mac-arm64.dmg");
    assert.equal(files.sha256_win_nsis, "TrackYourTime-Setup-1.2.3.exe");
    assert.equal(files.sha256_win_nsis_arm64, "TrackYourTime-Setup-1.2.3-arm64.exe");
    assert.equal(files.sha256_linux_x64_targz, "TrackYourTime-1.2.3-linux-x64.tar.gz");
    for (const name of Object.values(files)) assert.doesNotMatch(name, /unsigned/);
  });

  it("every placeholder a family needs has a file or a computed value", () => {
    const files = manifestArtifacts("1.2.3");
    for (const keys of Object.values(MANIFEST_FAMILIES)) {
      for (const key of keys) assert.ok(key in files || key in REPO_FILE_CHECKSUMS, key);
    }
  });

  it("every repo file a checksum is computed from is in the checkout", () => {
    for (const [key, file] of Object.entries(REPO_FILE_CHECKSUMS)) assert.ok(existsSync(root + file), `${key} names ${file}, which does not exist`);
  });

  it("refuses a missing or empty value instead of writing a blank checksum", () => {
    assert.equal(renderManifestTemplate("v{{version}}", { version: "1.0.0" }), "v1.0.0");
    assert.throws(() => renderManifestTemplate("{{version}} {{sha}}", { version: "1", sha: "" }), /\{\{sha\}\}/);
  });

  it("renders only the families whose release files are there, and names the rest", () => {
    const files = manifestArtifacts("1.2.3");
    const families = Object.keys(MANIFEST_FAMILIES);
    const everything = new Set(Object.values(files));
    assert.deepEqual(manifestFamilyPlan({ version: "1.2.3", families, has: (n) => everything.has(n) }), { render: families, skipped: [] });

    // An unsigned Windows leg attaches no installer; only winget is lost.
    const withoutWindows = new Set([...everything].filter((n) => !n.startsWith("TrackYourTime-Setup")));
    const plan = manifestFamilyPlan({ version: "1.2.3", families, has: (n) => withoutWindows.has(n) });
    assert.deepEqual(plan.render, ["homebrew", "flatpak"]);
    assert.deepEqual(plan.skipped, [{ family: "winget", missing: ["TrackYourTime-Setup-1.2.3.exe", "TrackYourTime-Setup-1.2.3-arm64.exe"] }]);
  });

  it("does not ask the release for the files that come from the checkout", () => {
    const plan = manifestFamilyPlan({ version: "1.2.3", families: ["flatpak"], has: (n) => n.endsWith(".tar.gz") });
    assert.deepEqual(plan.render, ["flatpak"]);
    const files = manifestArtifacts("1.2.3");
    for (const key of Object.keys(REPO_FILE_CHECKSUMS)) assert.ok(!(key in files), key);
  });

  it("the Flathub metadata promises nothing the Flatpak refuses", () => {
    const source = readFileSync(join(root, "packaging/flatpak/com.ricoslabs.trackyourtime.metainfo.xml.template"), "utf8");
    const metainfo = source.replace(/<!--[\s\S]*?-->/g, "");
    // tyt_model::distribution: no activity capture, no open at login, no
    // self-update in a Flatpak, so the listing must not offer any of the three.
    for (const promise of [/activity/i, /which app/i, /open at login/i, /updates itself/i, /automatic update/i]) {
      assert.doesNotMatch(metainfo, promise, `the metainfo promises ${promise}`);
    }
    const shots = [...metainfo.matchAll(/<image>(.+?)<\/image>/g)].map((m) => m[1]);
    assert.ok(shots.length >= 1, "no screenshot");
    for (const url of shots) {
      assert.match(url, /^https:\/\//, url);
      assert.doesNotMatch(url, /\{\{/, `${url} is versioned; Flathub's checker never rewrites a screenshot URL`);
    }
    assert.match(metainfo, /<launchable type="desktop-id">com\.ricoslabs\.trackyourtime\.desktop</);
  });

  it("the Flathub manifest repackages the Tauri executable on the GNOME runtime, not Electron", () => {
    const manifest = readFileSync(join(root, "packaging/flatpak/com.ricoslabs.trackyourtime.yml.template"), "utf8");
    assert.match(manifest, /^runtime: org\.gnome\.Platform$/m);
    assert.doesNotMatch(manifest.replace(/^\s*#.*$/gm, ""), /electron|zypak/i);
  });

  it("the committed templates use only placeholders the renderer can fill", () => {
    const known = new Set(["version", "release_date", ...Object.values(MANIFEST_FAMILIES).flat()]);
    for (const family of Object.keys(MANIFEST_FAMILIES)) {
      for (const name of readdirSync(join(root, "packaging", family)).filter((n) => n.endsWith(".template"))) {
        const used = [...readFileSync(join(root, "packaging", family, name), "utf8").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
        for (const key of used) {
          assert.ok(known.has(key), `${family}/${name} uses {{${key}}}`);
          if (key.startsWith("sha256_")) assert.ok(MANIFEST_FAMILIES[family].includes(key), `${family}/${name}: {{${key}}} not in its family`);
        }
      }
    }
  });
});

describe("update feeds", () => {
  const version = "0.4.0";
  const base = releaseDownloadBase({ version });

  it("the endpoint is the latest PUBLISHED release, so publishing the draft is the release decision", () => {
    assert.equal(UPDATER_ENDPOINT, "https://github.com/trebeljahr/trackyourtime/releases/latest/download/latest.json");
    assert.equal(base, "https://github.com/trebeljahr/trackyourtime/releases/download/v0.4.0/");
  });

  it("names both latest.json keys tauri-plugin-updater looks up", () => {
    assert.deepEqual(updaterTargets("macUpdater", "arm64"), ["darwin-aarch64-app", "darwin-aarch64"]);
    assert.deepEqual(updaterTargets("nsis", "x64"), ["windows-x86_64-nsis", "windows-x86_64"]);
    assert.deepEqual(updaterTargets("appimage", "arm64"), ["linux-aarch64-appimage", "linux-aarch64"]);
    assert.throws(() => updaterTargets("deb", "x64"), /No updater target/);
  });

  it("writes the Electron feeds the way electron-builder did, and electron-updater's parser reads them back", () => {
    const zip = feedDigest(Buffer.from("zip"));
    const text = legacyFeedText({
      version,
      files: [{ url: "TrackYourTime-0.4.0-mac-arm64.zip", ...zip }],
      releaseDate: "2026-11-12T10:00:00.000Z",
      dump: yaml.dump,
    });
    // The v0.3.0 latest-mac.yml has exactly these keys, in this order.
    assert.deepEqual(Object.keys(yaml.load(text)), ["version", "files", "path", "sha512", "releaseDate"]);
    assert.equal(yaml.load(text).releaseDate, "2026-11-12T10:00:00.000Z", "a date string, not a Date: electron-updater compares strings");
    assert.equal(yaml.load(text).files[0].sha512, zip.sha512);
    assert.match(text, /^version: 0\.4\.0$/m);
  });

  it("lists what electron-updater installs on each platform", () => {
    assert.deepEqual(legacyFeedNames({ leg: "mac", version, archs: ["arm64", "x64"] }), [
      "TrackYourTime-0.4.0-mac-arm64.zip",
      "TrackYourTime-0.4.0-mac-x64.zip",
      "TrackYourTime-0.4.0-mac-arm64.dmg",
      "TrackYourTime-0.4.0-mac-x64.dmg",
    ]);
    // One installer: electron-updater cannot choose between two.
    assert.deepEqual(legacyFeedNames({ leg: "win", version, archs: ["x64", "arm64"] }), ["TrackYourTime-Setup-0.4.0.exe"]);
    assert.deepEqual(legacyFeedNames({ leg: "linux-arm64", version, archs: ["arm64"] }), ["TrackYourTime-0.4.0-linux-arm64.AppImage"]);
  });

  it("writes latest.json with the staging percentage first, so it is one line to change", () => {
    const text = tauriFeedText({ version, notes: "n", pubDate: "2026-11-12T10:00:00.000Z", platforms: { "b-x": { url: `${base}b`, signature: "s" }, "a-x": { url: `${base}a`, signature: "s" } }, stagingPercentage: 10 });
    assert.equal(text.split("\n")[1], '  "stagingPercentage": 10,');
    assert.deepEqual(Object.keys(JSON.parse(text).platforms), ["a-x", "b-x"]);
    assert.doesNotMatch(tauriFeedText({ version, notes: "n", pubDate: "d", platforms: {} }), /stagingPercentage/);
  });

  it("merges every leg's fragment into one set of platforms, with this release's URLs", () => {
    const merged = mergeUpdaterFragments({
      version,
      base,
      fragments: [
        { name: "updater-mac.json", fragment: { version, platforms: { "darwin-aarch64-app": { file: "m.tar.gz", signature: "s1\n" } } } },
        { name: "updater-win.json", fragment: { version, platforms: { "windows-x86_64-nsis": { file: "w.exe", signature: "s2" } } } },
      ],
    });
    assert.deepEqual(merged.problems, []);
    assert.deepEqual(merged.platforms["darwin-aarch64-app"], { url: `${base}m.tar.gz`, signature: "s1" });
    assert.deepEqual([...merged.files.keys()], ["m.tar.gz", "w.exe"]);
  });

  it("refuses a fragment of another version, two legs for one target, and an entry with no signature", () => {
    const { problems } = mergeUpdaterFragments({
      version,
      base,
      fragments: [
        { name: "a", fragment: { version: "0.3.0", platforms: {} } },
        { name: "b", fragment: { version, platforms: { t: { file: "f", signature: "s" } } } },
        { name: "c", fragment: { version, platforms: { t: { file: "g", signature: "s" }, u: { file: "h", signature: "" } } } },
      ],
    });
    assert.equal(problems.length, 3);
    assert.match(problems[0], /for version 0\.3\.0/);
    assert.match(problems[1], /Two legs sign an update for t/);
    assert.match(problems[2], /u has no file or no signature/);
  });

  it("checks every latest.json URL against the attached files", () => {
    const feed = { version, platforms: { ok: { url: `${base}a`, signature: "s" }, gone: { url: `${base}b`, signature: "s" }, away: { url: "https://example.com/c", signature: "s" } } };
    const problems = tauriFeedProblems({ name: "latest.json", feed, version, base, attached: new Map([["a", {}]]) });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /names b, which is not attached/);
    assert.match(problems[1], /outside/);
    assert.match(tauriFeedProblems({ name: "latest.json", feed: { version: "0.3.0", platforms: {} }, version, base, attached: new Map() }).join(), /says version 0\.3\.0.*no platforms/);
  });
});

describe("releasePlan", () => {
  const signed = [
    {
      channel: "mac",
      mode: "signed",
      files: [
        "a/TrackYourTime-0.4.0-mac-arm64.dmg",
        "a/TrackYourTime-0.4.0-mac-arm64.zip",
        "a/TrackYourTime-0.4.0-mac-arm64.app.tar.gz",
        "a/TrackYourTime-0.4.0-mac-arm64.app.tar.gz.sig",
        "a/latest-mac.yml",
        "a/updater-mac.json",
        "a/SHA256SUMS-mac.txt",
      ],
    },
    { channel: "mas", mode: "signed", files: ["b/TrackYourTime-0.4.0-mas-universal.pkg"] },
    { channel: "win", mode: "signed", files: ["c/TrackYourTime-Setup-0.4.0.exe", "c/TrackYourTime-Setup-0.4.0-arm64.exe", "c/latest.yml", "c/updater-win.json"] },
    { channel: "win-store", mode: "store", files: ["d/TrackYourTime-0.4.0-x64-store.appx"] },
    {
      channel: "linux-x64",
      mode: "unsigned",
      files: ["e/TrackYourTime-0.4.0-linux-x86_64.AppImage", "e/trackyourtime_0.4.0_amd64.deb", "e/trackyourtime_0.4.0_amd64.snap", "e/latest-linux.yml", "e/updater-linux-x64.json"],
    },
  ];

  it("attaches downloads and both feeds' inputs, never store packages, signatures or per-leg checksums", () => {
    const plan = releasePlan(signed);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.feeds, ["a/latest-mac.yml", "c/latest.yml", "e/latest-linux.yml"]);
    assert.deepEqual(plan.fragments, ["a/updater-mac.json", "c/updater-win.json", "e/updater-linux-x64.json"]);
    assert.equal(plan.upload.some((f) => /\.(pkg|appx|snap|sig)$|SHA256SUMS|updater-/.test(f)), false);
    assert.ok(plan.upload.includes("e/trackyourtime_0.4.0_amd64.deb"));
    assert.ok(plan.upload.includes("a/TrackYourTime-0.4.0-mac-arm64.app.tar.gz"));
  });

  it("leaves unsigned mac and win files off the release page and says so", () => {
    const plan = releasePlan([{ channel: "mac", mode: "unsigned", files: ["a/TrackYourTime-0.4.0-mac-arm64-unsigned.dmg"] }, signed[4]]);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.upload.some((f) => f.includes("unsigned")), false);
    assert.match(plan.warnings[0], /mac was built unsigned/);
  });

  it("refuses a leg that updates itself without either feed, and a release with nothing to attach", () => {
    const noLegacy = releasePlan([{ ...signed[2], files: signed[2].files.filter((f) => !f.endsWith(".yml")) }]);
    assert.match(noLegacy.problems.join(), /win leg has no latest\.yml; Electron installs/);
    const noFragment = releasePlan([{ ...signed[4], files: signed[4].files.filter((f) => !f.endsWith(".json")) }]);
    assert.match(noFragment.problems.join(), /linux-x64 leg has no updater-linux-x64\.json.*TAURI_SIGNING_PRIVATE_KEY/);
    const empty = releasePlan([{ channel: "mas", mode: "signed", files: ["b/x.pkg"] }]);
    assert.match(empty.problems.at(-1), /Nothing to attach/);
  });
});

describe("feedProblems", () => {
  const attached = new Map([["TrackYourTime-0.4.0-mac-arm64.zip", { sha512: "abc", size: 10 }]]);

  it("accepts a feed whose files are attached with matching checksums", () => {
    assert.deepEqual(feedProblems([{ name: "latest-mac.yml", feed: { files: [{ url: "TrackYourTime-0.4.0-mac-arm64.zip", sha512: "abc", size: 10 }] } }], attached), []);
  });

  it("names a missing file, a checksum and a size mismatch, and an empty feed", () => {
    const problems = feedProblems(
      [
        { name: "latest-mac.yml", feed: { files: [{ url: "TrackYourTime-0.4.0-mac-x64.zip", sha512: "abc" }] } },
        { name: "latest-mac.yml", feed: { files: [{ url: "TrackYourTime-0.4.0-mac-arm64.zip", sha512: "zzz" }] } },
        { name: "latest-mac.yml", feed: { files: [{ url: "TrackYourTime-0.4.0-mac-arm64.zip", sha512: "abc", size: 11 }] } },
        { name: "latest.yml", feed: {} },
      ],
      attached,
    );
    assert.equal(problems.length, 4);
    assert.match(problems[0], /not attached/);
    assert.match(problems[1], /sha512/);
    assert.match(problems[2], /size/);
    assert.match(problems[3], /no files/);
  });
});

describe("the Electron install the Windows installer removes", () => {
  it("derives electron-builder's uninstall GUID (UUID v5 of the app id)", () => {
    // Computed with builder-util-runtime 9.7.0's own UUID.v5 before
    // electron-builder was removed from this repo.
    assert.equal(electronUninstallKeys().guid, "df978d67-ddd6-5da4-9e68-d9dbb1f39138");
    assert.equal(uuidV5("com.example.app", "50e065bc-3134-11e6-9bab-38c9862bdaf3"), "dff6f4cc-4982-57ce-ba84-58b12a17e4d9");
  });

  it("the NSIS hook removes exactly that install, keeping its profile", () => {
    const hooks = readFileSync(join(root, "build/windows/installer-hooks.nsh"), "utf8");
    const { guid } = electronUninstallKeys();
    assert.match(hooks, new RegExp(`!define TYT_ELECTRON_GUID "${guid}"`));
    assert.match(hooks, /!macro NSIS_HOOK_PREINSTALL/);
    // --updated and /KEEP_APP_DATA are what keep %APPDATA%\trackyourtime.
    assert.match(hooks, /ExecWait '"\$PLUGINSDIR\\tyt-electron-uninstall\.exe" \/S \/KEEP_APP_DATA \/currentuser --updated _\?=\$4'/);
    assert.doesNotMatch(hooks, /--delete-app-data/);
  });
});

describe("winget", () => {
  it("partitions by the identifier's first character and keeps its case", () => {
    assert.equal(WINGET_PACKAGE_IDENTIFIER, "ricoslabs.trackyourtime");
    assert.equal(wingetManifestPath("0.1.0"), "manifests/r/ricoslabs/trackyourtime/0.1.0");
    assert.equal(wingetManifestPath("1.0.0", "Microsoft.WingetCreate"), "manifests/m/Microsoft/WingetCreate/1.0.0");
    assert.equal(wingetManifestPath("1", "Microsoft.VisualStudio.2022.Community"), "manifests/m/Microsoft/VisualStudio/2022/Community/1");
  });

  it("refuses an identifier that is not Publisher.Package", () => {
    assert.throws(() => wingetManifestPath("1", "trackyourtime"), /PackageIdentifier/);
    assert.throws(() => wingetManifestPath("1", "ricoslabs."), /PackageIdentifier/);
  });

  it("titles the first submission as a new package and the rest as a new version", () => {
    assert.equal(wingetPrTitle({ version: "0.1.0", exists: false }), "New package: ricoslabs.trackyourtime version 0.1.0");
    assert.equal(wingetPrTitle({ version: "0.2.0", exists: true }), "New version: ricoslabs.trackyourtime version 0.2.0");
  });

  it("the committed manifests carry the identifier this path is derived from, and one installer per architecture", () => {
    const dir = join(root, "packaging/winget");
    const names = readdirSync(dir);
    assert.deepEqual(names.sort(), [`${WINGET_PACKAGE_IDENTIFIER}.installer.yaml.template`, `${WINGET_PACKAGE_IDENTIFIER}.locale.en-US.yaml.template`, `${WINGET_PACKAGE_IDENTIFIER}.yaml.template`].sort());
    for (const name of names) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.match(text, new RegExp(`^PackageIdentifier: ${WINGET_PACKAGE_IDENTIFIER}$`, "m"), name);
      assert.match(text, /^PackageVersion: \{\{version\}\}$/m, name);
      assert.doesNotMatch(text, /-unsigned/, name);
    }
    const installer = readFileSync(join(dir, `${WINGET_PACKAGE_IDENTIFIER}.installer.yaml.template`), "utf8");
    assert.match(installer, /TrackYourTime-Setup-\{\{version\}\}\.exe\n\s+InstallerSha256: \{\{sha256_win_nsis\}\}/);
    assert.match(installer, /TrackYourTime-Setup-\{\{version\}\}-arm64\.exe\n\s+InstallerSha256: \{\{sha256_win_nsis_arm64\}\}/);
  });
});

describe("snapPublishPlan", () => {
  const tag = { refType: "tag", refName: "v1.2.3", version: "1.2.3" };
  const creds = { [SNAP_CREDENTIALS_VAR]: "AgIL..." };

  it("skips with a reason, never a failure, when the credential is not set", () => {
    for (const env of [{}, { [SNAP_CREDENTIALS_VAR]: "" }, { [SNAP_CREDENTIALS_VAR]: "   " }]) {
      const plan = snapPublishPlan({ ...tag, env });
      assert.equal(plan.publish, false);
      assert.equal(plan.problem, null);
      assert.match(plan.skip, new RegExp(SNAP_CREDENTIALS_VAR));
    }
  });

  it("uploads nothing outside a tag, even with the credential set", () => {
    const plan = snapPublishPlan({ refType: "branch", refName: "main", version: "1.2.3", env: creds });
    assert.equal(plan.publish, false);
    assert.match(plan.skip, /not a tag/);
  });

  it("uploads a tag to candidate, never to stable", () => {
    assert.deepEqual(snapPublishPlan({ ...tag, env: creds }), { publish: true, channel: SNAP_RELEASE_CHANNEL, skip: null, problem: null });
    assert.notEqual(SNAP_RELEASE_CHANNEL, "stable");
    assert.notEqual(SNAP_PRERELEASE_CHANNEL, "stable");
  });

  it("stops a prerelease tag at beta", () => {
    assert.equal(snapPublishPlan({ refType: "tag", refName: "v1.2.3-rc.1", version: "1.2.3-rc.1", env: creds }).channel, SNAP_PRERELEASE_CHANNEL);
    assert.equal(isPrereleaseTag("v1.2.3-rc.1"), true);
  });

  it("is a problem when the tag does not name the version being packaged", () => {
    assert.match(snapPublishPlan({ refType: "tag", refName: "v1.2.4", version: "1.2.3", env: creds }).problem, /expected v1\.2\.3/);
  });

  it("names the registered snap, and the snap template describes it in one line", () => {
    assert.equal(SNAP_NAME, "trackyourtime");
    const snapcraft = readFileSync(join(root, "packaging/snap/snapcraft.yaml.template"), "utf8");
    assert.match(snapcraft, /^name: trackyourtime$/m);
    assert.match(snapcraft, /^confinement: strict$/m);
    const description = /^description: (.+)$/m.exec(snapcraft)?.[1];
    assert.ok(description && !/activity/i.test(description));
  });
});
