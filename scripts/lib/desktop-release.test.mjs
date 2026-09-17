import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  updateFeedFor,
  UPDATE_FEED,
  ALL_SIGNING_VARS,
  MANIFEST_FAMILIES,
  manifestArtifacts,
  renderManifestTemplate,
  artifactPatterns,
  builderEnvFor,
  expandArtifactName,
  masEntitlementsPlist,
  resolveSigning,
  SIGNING_CREDENTIAL_VARS,
  SIGNING_SETS,
  tagMismatch,
  targetChannelProblem,
  WINDOWS_STORE_IDENTITY,
  windowsStoreIdentityState,
} from "./desktop-release.mjs";

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
    assert.throws(() => resolveSigning("tauri", {}), /Unknown desktop channel/);
  });
});

describe("builderEnvFor", () => {
  it("marks an unsigned build and turns keychain discovery off", () => {
    const env = builderEnvFor("mac", { PATH: "/bin" }, { mode: "unsigned" });
    assert.equal(env.TRACKYOURTIME_UNSIGNED, "1");
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(env.PATH, "/bin");
  });

  it("never inherits the unsigned marker into a signed build", () => {
    const env = builderEnvFor("mac", { TRACKYOURTIME_UNSIGNED: "1" }, { mode: "signed", set: [] });
    assert.equal(env.TRACKYOURTIME_UNSIGNED, undefined);
  });

  it("strips every credential electron-builder would sign with on its own from an unsigned build", () => {
    // WIN_CSC_LINK falls back to CSC_LINK in electron-builder, so a Developer ID
    // p12 in the shell used to sign a Windows build still named -unsigned.
    const env = builderEnvFor("win", { ...all(SIGNING_CREDENTIAL_VARS), APPLE_TEAM_ID: "T" }, resolveSigning("win", { CSC_LINK: "x" }));
    for (const name of SIGNING_CREDENTIAL_VARS) assert.equal(env[name], undefined, name);
    assert.equal(env.APPLE_TEAM_ID, "T");
    assert.equal(env.TRACKYOURTIME_UNSIGNED, "1");
  });

  it("strips every signing variable from a Store package build", () => {
    const env = builderEnvFor("win-store", all(ALL_SIGNING_VARS), { mode: "store" });
    for (const name of ALL_SIGNING_VARS) assert.equal(env[name], undefined, name);
    assert.equal(env.TRACKYOURTIME_UNSIGNED, undefined);
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
  it("refuses an AppX outside the win-store channel, where electron-builder invents CN=ms", () => {
    assert.match(targetChannelProblem(null, ["--win", "appx", "--x64"]), /--channel win-store/);
    assert.match(targetChannelProblem("win", ["--win", "nsis", "AppX:arm64"]), /--channel win-store/);
  });

  it("refuses anything but an AppX in the win-store channel, which names nothing -unsigned", () => {
    assert.match(targetChannelProblem("win-store", ["--win", "nsis", "--x64"]), /AppX only/);
    assert.match(targetChannelProblem("win-store", ["--win", "appx", "nsis"]), /AppX only/);
    assert.match(targetChannelProblem("win-store", ["--dir"]), /AppX only/);
  });

  it("accepts the workflow's own invocations", () => {
    assert.equal(targetChannelProblem("win-store", ["--win", "appx", "--x64", "--arm64"]), null);
    assert.equal(targetChannelProblem("win", ["--win", "nsis", "--x64", "--arm64"]), null);
    assert.equal(targetChannelProblem("mac", ["--mac", "dmg", "zip", "--arm64", "--x64"]), null);
    assert.equal(targetChannelProblem(null, ["--dir"]), null);
  });
});

describe("artifact names", () => {
  it("says -unsigned in every name a person might download", () => {
    const patterns = artifactPatterns({ unsigned: true });
    for (const key of ["dmg", "zip", "mas", "nsis"]) assert.match(patterns[key], /-unsigned\./, key);
    assert.doesNotMatch(artifactPatterns({ unsigned: false }).dmg, /unsigned/);
  });

  it("expands like electron-builder and refuses a missing value", () => {
    const { dmg } = artifactPatterns({ unsigned: false });
    assert.equal(expandArtifactName(dmg, { version: "0.1.0", arch: "arm64", ext: "dmg" }), "TrackYourTime-0.1.0-mac-arm64.dmg");
    assert.throws(() => expandArtifactName(dmg, { version: "0.1.0" }), /No value for \$\{arch\}/);
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
  it("names the app group after the team and bundle id", () => {
    const plist = masEntitlementsPlist({ teamId: "ABCDE12345", appId: "com.trebeljahr.trackyourtime" });
    assert.match(plist, /<string>ABCDE12345\.com\.trebeljahr\.trackyourtime<\/string>/);
    assert.match(plist, /com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
  });

  it("leaves the group out rather than guessing a team", () => {
    assert.doesNotMatch(masEntitlementsPlist({ teamId: "", appId: "a.b" }), /application-groups/);
  });
});

describe("manifests", () => {
  it("point at the signed file names only", () => {
    const files = manifestArtifacts("1.2.3");
    assert.equal(files.sha256_mac_arm64_dmg, "TrackYourTime-1.2.3-mac-arm64.dmg");
    assert.equal(files.sha256_win_nsis, "TrackYourTime-Setup-1.2.3.exe");
    assert.equal(files.sha256_linux_x64_targz, "TrackYourTime-1.2.3-linux-x64.tar.gz");
    for (const name of Object.values(files)) assert.doesNotMatch(name, /unsigned/);
  });

  it("every placeholder a family needs has a file or a computed value", () => {
    const files = manifestArtifacts("1.2.3");
    for (const keys of Object.values(MANIFEST_FAMILIES)) {
      for (const key of keys) assert.ok(key in files || key === "sha256_icon_png", key);
    }
  });

  it("refuses a missing or empty value instead of writing a blank checksum", () => {
    assert.equal(renderManifestTemplate("v{{version}}", { version: "1.0.0" }), "v1.0.0");
    assert.throws(() => renderManifestTemplate("{{version}} {{sha}}", { version: "1", sha: "" }), /\{\{sha\}\}/);
  });

  it("the committed templates use only placeholders the renderer can fill", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../../packaging/", import.meta.url).pathname;
    const known = new Set(["version", "release_date", ...Object.values(MANIFEST_FAMILIES).flat()]);
    for (const family of Object.keys(MANIFEST_FAMILIES)) {
      for (const name of readdirSync(join(root, family)).filter((n) => n.endsWith(".template"))) {
        const used = [...readFileSync(join(root, family, name), "utf8").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
        for (const key of used) {
          assert.ok(known.has(key), `${family}/${name} uses {{${key}}}`);
          if (key.startsWith("sha256_")) assert.ok(MANIFEST_FAMILIES[family].includes(key), `${family}/${name}: {{${key}}} not in its family`);
        }
      }
    }
  });
});

describe("updateFeedFor", () => {
  it("gives signed direct downloads and every Linux build a GitHub feed", () => {
    assert.equal(updateFeedFor({ channel: "mac", unsigned: false }), UPDATE_FEED);
    assert.equal(updateFeedFor({ channel: "win", unsigned: false }), UPDATE_FEED);
    assert.equal(updateFeedFor({ channel: "linux", unsigned: true }), UPDATE_FEED);
    assert.equal(UPDATE_FEED.releaseType, "draft");
  });

  it("is null, not undefined, for everything else", () => {
    for (const input of [
      { channel: "mac", unsigned: true },
      { channel: "win", unsigned: true },
      { channel: "mas", unsigned: false },
      { channel: "win-store", unsigned: false },
      { channel: "local", unsigned: true },
      { channel: undefined, unsigned: false },
    ]) {
      assert.strictEqual(updateFeedFor(input), null, JSON.stringify(input));
    }
  });

  it("is what the electron-builder config publishes", async () => {
    const load = async (env) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        const url = new URL(`../../electron-builder.config.mjs?${JSON.stringify(env)}`, import.meta.url);
        return (await import(url.href)).default;
      } finally {
        for (const key of Object.keys(env)) {
          if (key in saved) process.env[key] = saved[key];
          else delete process.env[key];
        }
      }
    };
    assert.deepEqual((await load({ TRACKYOURTIME_DESKTOP_CHANNEL: "mac", TRACKYOURTIME_UNSIGNED: "" })).publish, UPDATE_FEED);
    assert.strictEqual((await load({ TRACKYOURTIME_DESKTOP_CHANNEL: "mac", TRACKYOURTIME_UNSIGNED: "1" })).publish, null);
    assert.strictEqual((await load({ TRACKYOURTIME_DESKTOP_CHANNEL: "mas", TRACKYOURTIME_UNSIGNED: "" })).publish, null);
    assert.strictEqual((await load({ TRACKYOURTIME_DESKTOP_CHANNEL: "", TRACKYOURTIME_UNSIGNED: "" })).publish, null);
  });
});
