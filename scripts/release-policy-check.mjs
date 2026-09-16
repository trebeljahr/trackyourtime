#!/usr/bin/env node
/**
 * Fails a release whose version number understates what changed.
 *
 *   node scripts/release-policy-check.mjs vX.Y.Z [ref]
 *
 * Compares `ref` (default HEAD) with the newest stable `v*` tag below
 * `vX.Y.Z`, using `scripts/lib/release-policy.mjs`: the API level, both
 * API-level floors and the migrations, then the written release record
 * (CHANGELOG heading, release notes, the migration and rollback sentences).
 *
 * Run by release.yml's `prepare` job before anything is built, so a tag that
 * breaks the policy publishes nothing. Needs the full history and tags
 * (`fetch-depth: 0`). Reads only; changes nothing.
 */
import { execFileSync } from "node:child_process";
import { checkRelease, EMPTY_CONTRACT, previousStableTag, readContract } from "./lib/release-policy.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const readerAt = (ref) => ({
  readFile: (path) => {
    try {
      return git("show", `${ref}:${path}`);
    } catch {
      return null;
    }
  },
  listDir: (dir) => {
    try {
      return git("ls-tree", "--name-only", `${ref}:${dir}`).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  },
});

const inActions = process.env.GITHUB_ACTIONS === "true";
const error = (message) =>
  console.error(inActions ? `::error::${message.replace(/\n/g, "%0A")}` : `ERROR: ${message}`);
const notice = (message) => console.log(inActions ? `::notice::${message}` : message);

const [version, ref = "HEAD"] = process.argv.slice(2);
if (!version) {
  error("usage: node scripts/release-policy-check.mjs vX.Y.Z [ref]");
  process.exit(2);
}

try {
  const tags = git("tag", "-l", "v*").split("\n").filter(Boolean);
  const previousVersion = previousStableTag(tags, version);
  const next = readerAt(ref);
  const result = checkRelease({
    version,
    previousVersion,
    previous: previousVersion ? readContract(...Object.values(readerAt(previousVersion))) : EMPTY_CONTRACT,
    next: readContract(next.readFile, next.listDir),
    readFile: next.readFile,
  });

  console.log(`Release policy: ${version} at ${ref}, previous stable release ${previousVersion ?? "none"}`);
  for (const line of result.notes) console.log(`  ${line}`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) error(problem);
    error("See docs/versioning.md → Release numbers, and the checklist in docs/releasing.md.");
    process.exit(1);
  }
  notice(`${version} follows the release policy.`);
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
