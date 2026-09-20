/**
 * Every copy of the release version against the root package.json.
 *
 * The root `version` is the single source of truth (docs/versioning.md). The
 * web export and the browser extension read it at build time; everything
 * below cannot, and keeps a literal copy. A copy that drifts ships a client
 * that reports the wrong version in the handshake and in Settings → Devices,
 * with nothing failing anywhere — so this fails instead, at the first test run
 * after a release bump that missed one.
 *
 * `scripts/build-mobile.mjs` asserts the iOS and Android copies again at build
 * time; they are here too so a bump is caught without a mobile build.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const rootVersion = JSON.parse(read("package.json")).version;

/** The one capture of `pattern` in a file, or a failure naming the file. */
const single = (relative, pattern) => {
  const matches = [...read(relative).matchAll(pattern)].map((match) => match[1].trim());
  assert.ok(matches.length > 0, `${relative}: no version found by ${pattern}`);
  return matches;
};

describe("release version copies", () => {
  it("the root package.json has a semver version", () => {
    assert.match(rootVersion, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("every workspace package.json that declares a version matches the root", () => {
    for (const name of readdirSync(join(ROOT, "packages"))) {
      const relative = `packages/${name}/package.json`;
      if (!existsSync(join(ROOT, relative))) continue;
      const { version } = JSON.parse(read(relative));
      // Raycast's manifest has no version field; its copy is checked below.
      if (version === undefined) continue;
      assert.equal(version, rootVersion, `${relative} version`);
    }
  });

  it("the Raycast and MCP constants match the root", () => {
    for (const version of single("packages/raycast/src/lib/version.ts", /export const APP_VERSION = "([^"]+)"/g)) {
      assert.equal(version, rootVersion, "packages/raycast/src/lib/version.ts");
    }
    for (const version of single("packages/mcp/src/server.ts", /export const SERVER_VERSION = "([^"]+)"/g)) {
      assert.equal(version, rootVersion, "packages/mcp/src/server.ts");
    }
  });

  it("the iOS and Android projects match the root", () => {
    for (const version of single("ios/App/App.xcodeproj/project.pbxproj", /MARKETING_VERSION = ([^;]+);/g)) {
      assert.equal(version, rootVersion, "ios MARKETING_VERSION");
    }
    for (const version of single("android/app/build.gradle", /^\s*versionName\s*=?\s*["']([^"']+)["']/gm)) {
      assert.equal(version, rootVersion, "android versionName");
    }
  });

  it("the web export and the extension read the root instead of keeping a copy", () => {
    const next = read("packages/client/next.config.ts");
    assert.match(next, /NEXT_PUBLIC_APP_VERSION: readRootVersion\(\)/);
    const manifest = read("packages/extension/manifest.config.ts");
    assert.match(manifest, /from "\.\.\/\.\.\/package\.json"/);
    assert.match(manifest, /export const RELEASE_VERSION: string = rootPackage\.version;/);
    const vite = read("packages/extension/vite.config.ts");
    assert.match(vite, /"import\.meta\.env\.VITE_APP_VERSION": JSON\.stringify\(RELEASE_VERSION\)/);
  });
});
