#!/usr/bin/env node
/*
 * Collect what the desktop release matrix built into the files of a DRAFT
 * GitHub Release:
 *
 *   node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir> [--staging-percentage <0-100 or "">] [--repo owner/name]
 *
 * `<artifacts>` holds one folder per leg, named as the workflow uploads them:
 * `desktop-<channel>-<mode>`. The rules for what is attached are
 * `releasePlan`, `feedProblems`, `mergeUpdaterFragments` and
 * `tauriFeedProblems` in scripts/lib/desktop-release.mjs. This script does the
 * file work:
 *
 *   - reads each leg's legacy feed (latest-mac.yml, latest.yml,
 *     latest-linux*.yml, which Electron installs read) and checks every file it
 *     names is attached with the stated sha512 and size;
 *   - merges every leg's updater fragment into latest.json (which the Tauri
 *     app reads), with download URLs of this release, and checks every payload
 *     it names is attached;
 *   - copies the files to `<out>` and writes one SHA256SUMS.txt over them.
 *
 * Warnings are printed as workflow annotations; any problem exits 1 and
 * nothing is uploaded.
 *
 * `--staging-percentage` writes `stagingPercentage` into every feed, YAML and
 * JSON alike (scripts/lib/desktop-rollout.mjs → `rewriteFeed`: one line, every
 * other byte kept). Empty or 100 leaves the key out, so every install is
 * offered the release. The feeds are checked against the attached files before
 * AND after the rewrite, so the sha512, size and URL guarantees do not depend
 * on it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  feedProblems,
  mergeUpdaterFragments,
  releaseDownloadBase,
  releasePlan,
  TAURI_FEED_FILE,
  tauriFeedProblems,
  tauriFeedText,
  UPDATE_FEED,
} from "./lib/desktop-release.mjs";
import { describeStaging, parseStagingPercentage, rewriteFeed } from "./lib/desktop-rollout.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const artifactsDir = option("--artifacts");
const outDir = option("--out");
if (!artifactsDir || !outDir) {
  console.error('Usage: node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir> [--staging-percentage <0-100 or "">] [--repo owner/name]');
  process.exit(1);
}
let stagingPercentage;
try {
  stagingPercentage = parseStagingPercentage(option("--staging-percentage"));
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exit(1);
}
const [owner, repo] = (option("--repo") || process.env.GITHUB_REPOSITORY || `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`).split("/");
if (!owner || !repo) {
  console.log("::error::--repo needs <owner>/<name>.");
  process.exit(1);
}
const base = releaseDownloadBase({ owner, repo, version });

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const MODES = new Set(["signed", "unsigned", "store"]);
const legs = [];
for (const name of existsSync(artifactsDir) ? readdirSync(artifactsDir) : []) {
  const match = /^desktop-(.+)-([a-z]+)$/.exec(name);
  if (!match || !MODES.has(match[2])) continue;
  legs.push({ channel: match[1], mode: match[2], files: walk(join(artifactsDir, name)) });
}

const plan = releasePlan(legs);
const problems = [...plan.problems];

const attached = new Map();
for (const file of plan.upload) {
  const name = basename(file);
  if (attached.has(name)) {
    problems.push(`Two legs built a file named ${name}.`);
    continue;
  }
  const bytes = readFileSync(file);
  attached.set(name, { file, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") });
}

// The Electron installs' feeds, read with js-yaml as electron-updater reads them.
const legacy = plan.feeds.map((file) => {
  const text = readFileSync(file, "utf8");
  return { name: basename(file), text, feed: yaml.load(text) };
});
problems.push(...feedProblems(legacy, attached));

// The Tauri app's feed, from every leg's fragment.
const fragments = plan.fragments.map((file) => ({ name: basename(file), fragment: JSON.parse(readFileSync(file, "utf8")) }));
const merged = mergeUpdaterFragments({ version, base, fragments });
problems.push(...merged.problems);
for (const file of merged.files.keys()) {
  if (!attached.has(file)) problems.push(`An updater fragment signs ${file}, which is not attached.`);
}
const tauriFeed =
  Object.keys(merged.platforms).length > 0
    ? tauriFeedText({
        version,
        notes: `Track Your Time ${version}. See https://github.com/${owner}/${repo}/releases/tag/v${version}.`,
        pubDate: new Date().toISOString(),
        platforms: merged.platforms,
      })
    : null;
if (tauriFeed) problems.push(...tauriFeedProblems({ name: TAURI_FEED_FILE, feed: JSON.parse(tauriFeed), version, base, attached }));
else if (legacy.length > 0) problems.push(`No leg signed an update, so there is no ${TAURI_FEED_FILE}: no Tauri install could ever update.`);

// The staged copies are what is uploaded, so they are checked the same way: a
// rewrite that broke a checksum or a URL would ship an update every installed
// app downloads and then rejects.
const staged = [];
for (const { name, text } of [...legacy, ...(tauriFeed ? [{ name: TAURI_FEED_FILE, text: tauriFeed }] : [])]) {
  try {
    const { text: next } = rewriteFeed({ name, text, percent: stagingPercentage, parse: yaml.load });
    staged.push({ name, text: next });
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
}
problems.push(
  ...feedProblems(
    staged.filter(({ name }) => name !== TAURI_FEED_FILE).map(({ name, text }) => ({ name, feed: yaml.load(text) })),
    attached,
  ),
);
for (const { name, text } of staged.filter(({ name }) => name === TAURI_FEED_FILE)) {
  problems.push(...tauriFeedProblems({ name, feed: JSON.parse(text), version, base, attached }));
}

for (const leg of legs) console.log(`${leg.channel}: ${leg.mode}, ${leg.files.length} files`);
for (const warning of plan.warnings) console.log(`::warning::${warning}`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`::error::${problem}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const sums = [];
for (const [name, { file }] of attached) {
  copyFileSync(file, join(outDir, name));
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${name}`);
}
for (const { name, text } of staged) writeFileSync(join(outDir, name), text);
writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
console.log(`\n${attached.size} files and ${staged.length} update feeds ready in ${outDir}`);
console.log(`latest.json answers: ${Object.keys(merged.platforms).sort().join(", ")}`);
console.log(`The feeds offer this release to ${describeStaging(stagingPercentage)}.`);
