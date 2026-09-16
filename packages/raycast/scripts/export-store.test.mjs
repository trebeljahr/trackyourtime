import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  LOCAL_DEFAULTS_LINE,
  STORE_SCRIPTS,
  monorepoLeftovers,
  sourceLeftovers,
  storeLocalDefaults,
  storeVendorHeader,
  visibleStrings,
  readLockImporter,
  storePackageJson,
  storeRange,
} from "./export-store.mjs";
import { RAYCAST_DIR, REPO_DIR } from "./vendor-core.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(RAYCAST_DIR, "package.json"), "utf8"));
const lock = readLockImporter(fs.readFileSync(path.join(REPO_DIR, "pnpm-lock.yaml"), "utf8"));

test("the store package.json installs from npm alone", () => {
  const out = storePackageJson(pkg, lock);
  assert.equal(out.private, undefined);
  assert.deepEqual(out.scripts, STORE_SCRIPTS);
  for (const [name, spec] of Object.entries({ ...out.dependencies, ...out.devDependencies })) {
    assert.doesNotMatch(spec, /^(workspace|link|file):/, name);
    assert.ok(!name.startsWith("@starter/"), name);
  }
  // Everything the manifest says about the extension is carried over untouched.
  for (const key of ["name", "title", "commands", "preferences", "icon", "categories"]) {
    assert.deepEqual(out[key], pkg[key], key);
  }
});

test("every monorepo dependency is in the lockfile importer", () => {
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(lock[name]?.version, `pnpm-lock.yaml has no packages/raycast entry for ${name}; run pnpm install`);
  }
});

test("ranges start at the lockfile's resolved version; pins and overrides stay", () => {
  assert.equal(storeRange("a", "^2.1.0", { specifier: "^2.1.0", version: "2.1.2(@types/node@22.19.17)" }), "^2.1.2");
  assert.equal(storeRange("b", "19.0.10", { specifier: "^19.2.14", version: "19.2.14" }), "19.0.10");
  assert.equal(storeRange("c", "^1.0.0", { specifier: "^1.2.0", version: "1.2.0" }), "^1.0.0");
  assert.throws(() => storeRange("d", "workspace:*", undefined), /Vendor it/);
});

test("author and license overrides apply to the copy only", () => {
  const out = storePackageJson(pkg, lock, { author: "someone", license: "MIT" });
  assert.equal(out.author, "someone");
  assert.equal(out.license, "MIT");
  assert.notEqual(pkg.license, undefined);
});

test("the README the store page shows carries no maintainer-only steps", () => {
  assert.deepEqual(monorepoLeftovers(fs.readFileSync(path.join(RAYCAST_DIR, "README.md"), "utf8")), []);
  assert.ok(monorepoLeftovers("## Publishing\n\nRun pnpm vendor:raycast").length > 0);
});

test("the monorepo's ray develop build defaults to localhost; the store copy's does not", () => {
  const text = fs.readFileSync(path.join(RAYCAST_DIR, "src/lib/local-defaults.ts"), "utf8");
  assert.ok(text.includes(LOCAL_DEFAULTS_LINE), "packages/raycast keeps DEV_BUILD_USES_LOCALHOST = true");
  const store = storeLocalDefaults(text);
  assert.ok(store.includes("export const DEV_BUILD_USES_LOCALHOST: boolean = false;"));
  assert.ok(!store.includes(LOCAL_DEFAULTS_LINE));
  assert.throws(() => storeLocalDefaults("export const DEV_BUILD_USES_LOCALHOST = true;"), /exactly once/);
  const prefs = fs.readFileSync(path.join(RAYCAST_DIR, "src/lib/preferences.ts"), "utf8");
  assert.match(prefs, /isDevBuild\(\) && DEV_BUILD_USES_LOCALHOST/);
});

test("no string a store user can see names monorepo tooling", () => {
  assert.deepEqual(sourceLeftovers(), []);
  const strings = visibleStrings("x.tsx", "// pnpm in a comment\nconst a = <Detail markdown={`run pnpm dev`} />;");
  assert.deepEqual(strings, ["run pnpm dev"]);
});

test("vendored files get a store-facing header and are otherwise unchanged", () => {
  const vendored = fs.readFileSync(path.join(RAYCAST_DIR, "src/vendor/core/ids.ts"), "utf8");
  const store = storeVendorHeader(vendored);
  assert.match(store, /^\/\/ Copied from packages\/core\/src\/ids\.ts in the Track Your Time repository/);
  assert.doesNotMatch(store, /vendor-core\.mjs|vendor:raycast/);
  assert.equal(store.split("\n").slice(2).join("\n"), vendored.split("\n").slice(2).join("\n"));
  const index = storeVendorHeader(fs.readFileSync(path.join(RAYCAST_DIR, "src/vendor/index.ts"), "utf8"));
  assert.doesNotMatch(index, /GENERATED|vendor-core\.mjs|vendor:raycast/);
  assert.match(index, /^\/\/ The names this extension imports/);
  assert.throws(() => storeVendorHeader("let x = 1;\n"), /no GENERATED header/);
});
