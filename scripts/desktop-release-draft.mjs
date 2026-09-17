#!/usr/bin/env node
/*
 * Collect what the desktop release matrix built into the files of a DRAFT
 * GitHub Release (Stage 7, docs/desktop-app-plan.md):
 *
 *   node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir>
 *
 * `<artifacts>` holds one folder per leg, named as the workflow uploads them:
 * `desktop-<channel>-<mode>`. The rules for what is attached are
 * `releasePlan` and `feedProblems` in scripts/lib/desktop-release.mjs. This
 * script does the file work: it reads each update feed, checks every file the
 * feed names is attached with the stated sha512 and size, copies the files to
 * `<out>`, and writes one SHA256SUMS.txt over them. Warnings are printed as
 * workflow annotations; any problem exits 1 and nothing is uploaded.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { feedProblems, releasePlan } from "./lib/desktop-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// js-yaml is electron-updater's own parser, so the feed is read the way the
// updater reads it.
const updaterDir = realpathSync(join(repoRoot, "node_modules/electron-updater"));
const yaml = createRequire(join(updaterDir, "package.json"))("js-yaml");

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const artifactsDir = option("--artifacts");
const outDir = option("--out");
if (!artifactsDir || !outDir) {
  console.error("Usage: node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir>");
  process.exit(1);
}

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

const feeds = plan.feeds.map((file) => ({ name: basename(file), file, feed: yaml.load(readFileSync(file, "utf8")) }));
problems.push(...feedProblems(feeds, attached));

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
for (const { name, file } of feeds) copyFileSync(file, join(outDir, name));
writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
console.log(`\n${attached.size} files and ${feeds.length} update feeds ready in ${outDir}`);
