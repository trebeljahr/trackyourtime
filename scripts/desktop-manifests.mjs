#!/usr/bin/env node
/*
 * Render the package-manager manifests for one desktop release: the Homebrew
 * cask, the winget manifests and the Flathub manifest + AppStream metadata.
 *
 *   node scripts/desktop-manifests.mjs --artifacts <dir> --out <dir> [--only homebrew,winget,flatpak] [--date YYYY-MM-DD]
 *
 * <dir> holds the release's files as published (the workflow downloads them
 * with `gh release download`). The version is the root package.json's, the
 * same one build-desktop.mjs asserts inside every package, and each checksum
 * is computed from the real file, so a manifest never names a file the release
 * does not contain. Nothing here submits anything: the tap commit, the
 * winget-pkgs pull request and the Flathub repository are manual or gated
 * steps (docs/deploy.md → "Desktop release").
 *
 * Templates live in packaging/<family>/*.template; files there without the
 * suffix are copied unchanged.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_FAMILIES, manifestArtifacts, renderManifestTemplate } from "./lib/desktop-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n  desktop-manifests — ${message}\n`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
}

const artifactsDir = option("--artifacts");
const outDir = option("--out");
if (!artifactsDir || !outDir) fail("usage: --artifacts <dir> --out <dir> [--only homebrew,winget,flatpak] [--date YYYY-MM-DD]");

const families = (option("--only") ?? Object.keys(MANIFEST_FAMILIES).join(",")).split(",").map((f) => f.trim());
for (const family of families) {
  if (!(family in MANIFEST_FAMILIES)) fail(`Unknown family "${family}". Expected: ${Object.keys(MANIFEST_FAMILIES).join(", ")}.`);
}

const date = option("--date") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got "${date}".`);

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const files = manifestArtifacts(version);
const values = { version, release_date: date };
const needed = new Set(families.flatMap((family) => MANIFEST_FAMILIES[family]));
const missing = [];
for (const key of needed) {
  if (key === "sha256_icon_png") {
    // Flathub fetches build/icon.png at the release tag; the checkout the
    // workflow runs from is that tag.
    values[key] = sha256(join(repoRoot, "build/icon.png"));
    continue;
  }
  const file = join(artifactsDir, files[key]);
  if (!existsSync(file)) {
    missing.push(files[key]);
    continue;
  }
  values[key] = sha256(file);
}
if (missing.length) {
  fail(`${artifactsDir} is missing release files for ${families.join(", ")}:\n    ${missing.join("\n    ")}`);
}

for (const family of families) {
  const source = join(repoRoot, "packaging", family);
  const target = join(outDir, family);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.endsWith(".template")) {
      const rendered = renderManifestTemplate(readFileSync(join(source, name), "utf8"), values);
      writeFileSync(join(target, name.slice(0, -".template".length)), rendered);
    } else {
      copyFileSync(join(source, name), join(target, name));
    }
  }
  console.log(`  ${family}: ${readdirSync(target).join(", ")}`);
}
