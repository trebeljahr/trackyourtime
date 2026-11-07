/*
 * The generated native files that are committed (CLAUDE.md → "Mobile") name
 * pnpm's content-addressed store paths and the capacitor-swift-pm version.
 * A lockfile change renames those directories, and only `pnpm build:mobile`
 * rewrites the files, so they drift silently: builds keep working because the
 * build regenerates them, while a checkout that opens ios/App in Xcode or runs
 * Gradle without building first fails to resolve. This compares them with
 * what `pnpm install` actually put in node_modules.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const spmDir = resolve(repoRoot, "ios/App/CapApp-SPM");
const androidDir = resolve(repoRoot, "android");
const iosPackage = resolve(repoRoot, "node_modules/@capacitor/ios/package.json");

const FIX =
  "Run `NEXT_PUBLIC_API_URL=http://localhost:<port> pnpm build:mobile`, build ios/App once " +
  "with xcodebuild (it rewrites Package.resolved), and commit the three files.";

const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const realOrNull = (path) => (existsSync(path) ? realpathSync(path) : null);

/** Each store path must land where the root node_modules link for that package points. */
function assertStorePaths(file, baseDir, paths) {
  assert.ok(paths.length > 0, `${file}: no node_modules paths found`);
  for (const path of paths) {
    const pkgPath = path.split("/node_modules/").pop();
    const installed = realOrNull(resolve(repoRoot, "node_modules", pkgPath));
    assert.ok(installed, `${file}: ${pkgPath} is not installed at the repository root`);
    assert.equal(realOrNull(resolve(baseDir, path)), installed, `${file} names ${path}, not the installed ${pkgPath}. ${FIX}`);
  }
}

describe("generated native files match the installed Capacitor", { skip: !existsSync(iosPackage) && "@capacitor/ios is not installed" }, () => {
  const capacitorVersion = () => JSON.parse(readFileSync(iosPackage, "utf8")).version;

  it("Package.swift names the installed store paths and capacitor-swift-pm version", () => {
    const source = read("ios/App/CapApp-SPM/Package.swift");
    assert.equal(source.match(/capacitor-swift-pm\.git", exact: "([^"]+)"/)?.[1], capacitorVersion(), `Package.swift pins another capacitor-swift-pm. ${FIX}`);
    assertStorePaths("Package.swift", spmDir, [...source.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]));
  });

  it("Package.resolved pins the same capacitor-swift-pm", () => {
    const resolved = JSON.parse(read("ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"));
    const pin = resolved.pins.find((p) => p.identity === "capacitor-swift-pm");
    assert.equal(pin?.state.version, capacitorVersion(), `Package.resolved pins another capacitor-swift-pm. ${FIX}`);
  });

  it("capacitor.settings.gradle names the installed store paths", () => {
    const source = read("android/capacitor.settings.gradle");
    assertStorePaths("capacitor.settings.gradle", androidDir, [...source.matchAll(/new File\('([^']+)'\)/g)].map((m) => m[1]));
  });
});
