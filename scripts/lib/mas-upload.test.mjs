import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_ID, altoolArgs, apiKeyFrom, masInfoProblems, parseMasUploadArgs } from "./mas-upload.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("parseMasUploadArgs", () => {
  it("defaults to the newest run, uploading", () => {
    assert.deepEqual(parseMasUploadArgs([]), { run: null, pkg: null, repo: null, dryRun: false, help: false });
  });

  it("takes a run id or a pkg, never both", () => {
    assert.equal(parseMasUploadArgs(["--run", "36941084893", "--dry-run"]).run, "36941084893");
    assert.equal(parseMasUploadArgs(["--pkg", "a/b.pkg"]).pkg, "a/b.pkg");
    assert.throws(() => parseMasUploadArgs(["--run", "1", "--pkg", "a.pkg"]), /two different builds/);
    assert.throws(() => parseMasUploadArgs(["--run", "latest"]), /numeric run id/);
    assert.throws(() => parseMasUploadArgs(["--pkg", "a.dmg"]), /\.pkg file/);
    assert.throws(() => parseMasUploadArgs(["--run"]), /needs a value/);
    assert.throws(() => parseMasUploadArgs(["--upload"]), /Unknown argument/);
  });
});

describe("apiKeyFrom", () => {
  const env = {
    APPLE_API_KEY: "/Users/x/Downloads/AuthKey_28G47BVTY7.p8",
    APPLE_API_KEY_ID: "28G47BVTY7",
    APPLE_API_ISSUER: "fe992c77-dd56-4ec2-9552-9ffb12bed05f",
  };

  it("hands altool the key's folder, where it looks the id up", () => {
    assert.deepEqual(apiKeyFrom(env), { keyId: "28G47BVTY7", issuer: env.APPLE_API_ISSUER, keysDir: "/Users/x/Downloads" });
  });

  it("names every missing variable", () => {
    assert.throws(() => apiKeyFrom({}), /APPLE_API_KEY .*APPLE_API_KEY_ID.*APPLE_API_ISSUER/);
  });

  it("refuses a key file altool would not find by id", () => {
    assert.throws(() => apiKeyFrom({ ...env, APPLE_API_KEY: "/k/key.p8" }), /must be named AuthKey_28G47BVTY7\.p8/);
  });
});

describe("masInfoProblems", () => {
  const good = {
    CFBundleIdentifier: APP_ID,
    CFBundleShortVersionString: "0.2.2",
    CFBundleVersion: "4512301",
    ITSAppUsesNonExemptEncryption: false,
    ElectronTeamID: "4BHY8H2J25",
    CFBundleIconName: "Icon",
  };

  it("passes a store-ready app", () => {
    assert.deepEqual(masInfoProblems(good, { version: "0.2.2", hasAssetCatalog: true }), []);
  });

  it("refuses what App Store Connect would refuse", () => {
    const problems = (info, hasAssetCatalog = true) => masInfoProblems({ ...good, ...info }, { version: "0.2.2", hasAssetCatalog });
    assert.match(problems({ CFBundleIdentifier: "com.example" }).join(), /CFBundleIdentifier/);
    assert.match(problems({ CFBundleShortVersionString: "0.2.1" }).join(), /package\.json says 0\.2\.2/);
    assert.match(problems({ CFBundleVersion: "0.2.2" }).join(), /without DESKTOP_BUILD_NUMBER/);
    assert.match(problems({ CFBundleVersion: "build-7" }).join(), /not a build number/);
    assert.match(problems({ ITSAppUsesNonExemptEncryption: undefined }).join(), /ITSAppUsesNonExemptEncryption/);
    assert.match(problems({ ElectronTeamID: undefined }).join(), /ElectronTeamID/);
    assert.match(problems({}, false).join(), /placeholder/);
    assert.match(problems({ CFBundleIconName: undefined }).join(), /placeholder/);
  });
});

describe("altoolArgs", () => {
  it("uploads as a macOS app with the API key", () => {
    assert.deepEqual(altoolArgs("upload-app", "x.pkg", { keyId: "K", issuer: "I" }), [
      "altool",
      "--upload-app",
      "--file",
      "x.pkg",
      "--type",
      "macos",
      "--apiKey",
      "K",
      "--apiIssuer",
      "I",
    ]);
  });
});

describe("the release wiring", () => {
  it("numbers the mas build in desktop-release.yml, which the config reads", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
    assert.match(workflow, /DESKTOP_BUILD_NUMBER=\$\(\(GITHUB_RUN_NUMBER \* 100 \+ GITHUB_RUN_ATTEMPT\)\)/);
    const config = readFileSync(join(repoRoot, "electron-builder.config.mjs"), "utf8");
    assert.match(config, /bundleVersion: env\("DESKTOP_BUILD_NUMBER"\)/);
  });

  it("gives macOS the Icon Composer document icons:brand writes", () => {
    const config = readFileSync(join(repoRoot, "electron-builder.config.mjs"), "utf8");
    assert.match(config, /icon: "build\/AppIcon\.icon"/);
    const doc = JSON.parse(readFileSync(join(repoRoot, "build/AppIcon.icon/icon.json"), "utf8"));
    const layer = doc.groups[0].layers[0]["image-name"];
    assert.ok(readFileSync(join(repoRoot, "build/AppIcon.icon/Assets", layer), "utf8").startsWith("<svg"));
  });
});
