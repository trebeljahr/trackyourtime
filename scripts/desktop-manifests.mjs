#!/usr/bin/env node
/*
 * Render the package-manager manifests for one desktop release: the Homebrew
 * cask, the winget manifests and the Flathub manifest + AppStream metadata.
 *
 *   node scripts/desktop-manifests.mjs --artifacts <dir> --out <dir> [--only homebrew,winget,flatpak] [--date YYYY-MM-DD] [--skip-missing]
 *
 * <dir> holds the release's files as published (the workflow downloads them
 * with `gh release download`). The version is the root package.json's, the
 * same one build-desktop.mjs asserts inside every package, and each checksum
 * is computed from the real file, so a manifest never names a file the release
 * does not contain. Nothing here submits anything: the tap commit, the
 * winget-pkgs pull request (scripts/winget-submit.mjs) and the Flathub
 * repository are separate, token-gated or manual steps
 * (docs/deploy.md -> "Desktop release").
 *
 * `--skip-missing` renders the families whose files the release actually
 * carries and prints a notice for the rest, instead of refusing. A release
 * attaches no `-unsigned` file, so an unsigned leg simply has no download to
 * point at, and that must cost that leg alone. Without the flag any missing
 * file is still a refusal, so a local run and an explicit `--only winget`
 * cannot quietly render nothing.
 *
 * Templates live in packaging/<family>/*.template; files there without the
 * suffix are copied unchanged.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_FAMILIES, manifestArtifacts, manifestFamilyPlan, renderManifestTemplate } from "./lib/desktop-release.mjs";

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
if (!artifactsDir || !outDir) fail("usage: --artifacts <dir> --out <dir> [--only homebrew,winget,flatpak] [--date YYYY-MM-DD] [--skip-missing]");

const families = (option("--only") ?? Object.keys(MANIFEST_FAMILIES).join(",")).split(",").map((f) => f.trim());
for (const family of families) {
  if (!(family in MANIFEST_FAMILIES)) fail(`Unknown family "${family}". Expected: ${Object.keys(MANIFEST_FAMILIES).join(", ")}.`);
}

const date = option("--date") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got "${date}".`);

const skipMissing = process.argv.includes("--skip-missing");

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const files = manifestArtifacts(version);
const plan = manifestFamilyPlan({ version, families, has: (name) => existsSync(join(artifactsDir, name)) });

if (skipMissing) {
  for (const { family, missing } of plan.skipped) {
    console.log(
      `::notice::${family}: skipped — ${artifactsDir} has no ${missing.join(", ")}. ` +
        "A release never attaches an -unsigned file, so an unsigned leg has no download to point at.",
    );
  }
} else if (plan.skipped.length) {
  const missing = plan.skipped.flatMap((entry) => entry.missing);
  fail(`${artifactsDir} is missing release files for ${plan.skipped.map((entry) => entry.family).join(", ")}:\n    ${missing.join("\n    ")}`);
}
const rendering = plan.render;
if (rendering.length === 0) {
  fail(`None of ${families.join(", ")} has its release files in ${artifactsDir}; there is nothing to render.`);
}

const values = { version, release_date: date };
for (const key of new Set(rendering.flatMap((family) => MANIFEST_FAMILIES[family]))) {
  if (key === "sha256_icon_png") {
    // Flathub fetches build/icon.png at the release tag; the checkout the
    // workflow runs from is that tag.
    values[key] = sha256(join(repoRoot, "build/icon.png"));
    continue;
  }
  values[key] = sha256(join(artifactsDir, files[key]));
}

for (const family of rendering) {
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

// The submitting jobs are gated on this: a family that rendered nothing has no
// manifests in the artifact, and must not have a pull request opened for it.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `families=${rendering.join(",")}\n`);
