#!/usr/bin/env node
/**
 * Cuts a release locally: one commit and one annotated tag, never a push.
 *
 *   pnpm release X.Y.Z [--dry-run] [--skip-tests] [--yes]
 *
 * docs/releasing.md → Steps is the contract; this script is its step 1 and 3
 * done in order, with the checks release.yml's `prepare` job would run on the
 * tag done first, here, where a failure costs nothing:
 *
 *  1. Refuses a dirty tree, a branch other than `main`, a `main` behind
 *     `origin/main`, missing remote tags, an existing tag, or a version that
 *     is not newer than the root package.json (the untagged current version
 *     is allowed: that is the first release).
 *  2. Plans every rewrite (`scripts/lib/release.mjs`): the root version and
 *     every hand-kept copy, the iOS and Android build numbers, the CHANGELOG
 *     roll and its links, and a draft of `docs/release-notes/vX.Y.Z.md` when
 *     there is none — in which case it writes only that file and stops, so a
 *     person rewrites it first (`--yes` takes the draft as it is).
 *  3. Runs `scripts/release-policy-check.mjs` against a commit object built
 *     from the plan in a throwaway index. The check reads files at a ref, and
 *     this lets it read the release exactly as it will be tagged without
 *     moving HEAD or touching the working tree.
 *  4. Writes the files and runs `pnpm run test:unit` (unless --skip-tests);
 *     a failure restores every file it wrote.
 *  5. Commits `chore(release): vX.Y.Z`, checks the commit's tree is the one
 *     the policy check passed, and creates the annotated tag.
 *
 * `--dry-run` does 1–3 and prints the diff; it writes only unreferenced git
 * objects, which `git gc` removes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PUSH_EFFECTS, localDate, parseStableVersion, planRelease, versionRefusal } from "./lib/release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const git = (args, options = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });

const fail = (message) => {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
};

const usage = "usage: pnpm release X.Y.Z [--dry-run] [--skip-tests] [--yes]";
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknown = [...flags].filter((flag) => !["--dry-run", "--skip-tests", "--yes", "--help"].includes(flag));
if (flags.has("--help")) {
  console.log(usage);
  process.exit(0);
}
if (unknown.length > 0 || positional.length !== 1) fail(`${unknown.length ? `unknown ${unknown.join(" ")}\n` : ""}${usage}`);

const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");
const yes = flags.has("--yes");
const parsed = parseStableVersion(positional[0]);
if (!parsed) fail(versionRefusal({ current: "0.0.0", next: positional[0], tags: [] }));
const version = parsed.version;
const tag = `v${version}`;

// ── 1. Preflight ────────────────────────────────────────────────────────

/** In a dry run a refusal is reported and the plan still printed. */
const refusals = [];
const refuse = (message) => {
  if (!dryRun) fail(message);
  refusals.push(message);
};

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (branch !== "main") refuse(`releases are cut from main; this checkout is on ${branch}`);
const dirty = git(["status", "--porcelain"]).trim();
if (dirty !== "") refuse(`the working tree is not clean:\n${dirty}`);

const hasRef = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT }).status === 0;
if (hasRef("refs/remotes/origin/main")) {
  const behind = git(["rev-list", "--count", "HEAD..origin/main"]).trim();
  if (behind !== "0") {
    refuse(`main is ${behind} commit(s) behind origin/main (as of the last fetch); rebase onto it first`);
  }
}

const localTags = git(["tag", "-l"]).split("\n").filter(Boolean);
let remoteTags = [];
try {
  remoteTags = git(["ls-remote", "--tags", "--refs", "origin"], { timeout: 20_000 })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].replace(/^refs\/tags\//, ""));
} catch {
  console.warn("release: could not list origin's tags (offline?); checking local tags only.");
}
// The policy check finds the previous release among LOCAL tags. Without them
// it compares against nothing and passes a bump it should refuse.
const missing = remoteTags.filter((name) => name.startsWith("v") && !localTags.includes(name));
if (missing.length > 0) refuse(`origin has tags this checkout lacks (${missing.join(", ")}); run: git fetch --tags origin`);

const readHead = (path) => {
  const result = spawnSync("git", ["show", `HEAD:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};
const current = JSON.parse(readHead("package.json") ?? "{}").version;
const versionProblem = versionRefusal({ current, next: version, tags: [...new Set([...localTags, ...remoteTags])] });
if (versionProblem) fail(versionProblem);

// ── 2. Plan ─────────────────────────────────────────────────────────────

const workspacePackages = git(["ls-tree", "--name-only", "HEAD", "packages/"])
  .split("\n")
  .filter(Boolean)
  .map((dir) => `${dir}/package.json`);

let plan;
try {
  plan = planRelease({ version, date: localDate(new Date()), readFile: readHead, workspacePackages });
} catch (caught) {
  fail(caught instanceof Error ? caught.message : String(caught));
}

console.log(`Release ${tag} (from ${current}${current === version ? ", untagged" : ""})`);
for (const { path, before } of plan.changes) console.log(`  ${before === null ? "create" : "update"} ${path}`);
console.log(`  iOS build ${plan.iosBuild}, Android versionCode ${plan.androidCode}`);

if (plan.notesCreated && !dryRun && !yes) {
  const notes = plan.changes.find((change) => change.path === plan.notesPath);
  writeFileSync(join(ROOT, plan.notesPath), notes.after);
  console.log(
    `\nWrote a draft of ${plan.notesPath} from the changelog. It is the GitHub release page:\n` +
      "rewrite it for someone deciding whether to upgrade, then commit it on main and run this again:\n\n" +
      `  git add ${plan.notesPath} && git commit -m "docs: release notes for ${tag}"\n` +
      `  pnpm release ${version}\n\n` +
      "Nothing else was changed. --yes releases with the draft as it is.",
  );
  process.exit(1);
}

// ── 3. Policy check against the planned tree ────────────────────────────

const commitMessage = `chore(release): ${tag}`;
const scratch = mkdtempSync(join(tmpdir(), "trackyourtime-release-"));
let plannedTree;
let plannedCommit;
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  git(["read-tree", "HEAD"], { env });
  for (const { path, after } of plan.changes) {
    const mode = git(["ls-tree", "HEAD", "--", path]).split(" ")[0] || "100644";
    const blob = git(["hash-object", "-w", "--stdin"], { input: after }).trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
  }
  plannedTree = git(["write-tree"], { env }).trim();
  plannedCommit = git(["commit-tree", plannedTree, "-p", "HEAD", "-m", commitMessage]).trim();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
const policy = spawnSync(process.execPath, ["scripts/release-policy-check.mjs", tag, plannedCommit], {
  cwd: ROOT,
  stdio: "inherit",
});
const policyPassed = policy.status === 0;

if (dryRun) {
  console.log(`\n── Planned changes (git diff HEAD ${plannedCommit.slice(0, 10)}) ──\n`);
  spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD", plannedCommit], { cwd: ROOT, stdio: "inherit" });
  spawnSync("git", ["--no-pager", "diff", "HEAD", plannedCommit], { cwd: ROOT, stdio: "inherit" });
  if (plan.notesCreated) {
    console.log(`\n${plan.notesPath} does not exist: a real run writes this draft and stops for you to edit it.`);
  }
  console.log(`\nDry run: nothing was written.${skipTests ? "" : " A real run also runs pnpm run test:unit."}`);
  for (const message of refusals) console.log(`A real run would refuse: ${message}`);
  if (!policyPassed) console.log("A real run would stop at the release policy check above.");
  process.exit(refusals.length > 0 || !policyPassed ? 1 : 0);
}

if (!policyPassed) fail("the release policy check failed; nothing was changed.");

// ── 4. Write and test ───────────────────────────────────────────────────

const written = [];
const restore = () => {
  for (const { path, before } of written) {
    if (before === null) unlinkSync(join(ROOT, path));
    else git(["checkout", "HEAD", "--", path]);
  }
};
for (const change of plan.changes) {
  writeFileSync(join(ROOT, change.path), change.after);
  written.push(change);
}

if (!skipTests) {
  console.log("\nRunning pnpm run test:unit …\n");
  const tests = spawnSync("pnpm", ["run", "test:unit"], { cwd: ROOT, stdio: "inherit" });
  if (tests.status !== 0) {
    restore();
    fail("pnpm run test:unit failed; every file this run wrote was restored.");
  }
}

// ── 5. Commit and tag ───────────────────────────────────────────────────

try {
  git(["add", "--", ...plan.changes.map((change) => change.path)]);
  git(["commit", "-m", commitMessage], { stdio: ["pipe", "inherit", "inherit"] });
} catch {
  restore();
  git(["reset", "--quiet", "--", ...plan.changes.map((change) => change.path)]);
  fail("git commit failed; every file this run wrote was restored.");
}

// A commit hook could have changed what was committed. The tag must name the
// tree the policy check passed, or the check vouched for something else.
const committedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
if (committedTree !== plannedTree) {
  fail(
    `the commit's tree (${committedTree}) is not the one the policy check passed (${plannedTree}).\n` +
      "A commit hook probably changed files. The commit stays; no tag was created. Inspect it with git show.",
  );
}
git(["tag", "-a", tag, "-m", `Track Your Time ${version}`]);

const sha = git(["rev-parse", "--short", "HEAD"]).trim();
console.log(`\nCommitted ${sha} ${commitMessage} and tagged ${tag}. Nothing was pushed.\n`);
console.log("Push when ready, main first, so the tag's commit is on main when its workflows start:\n");
console.log(`  git push origin main && git push origin ${tag}\n`);
for (const { command, effects } of PUSH_EFFECTS) {
  console.log(`  ${typeof command === "function" ? command(tag) : command}`);
  for (const effect of effects) console.log(`    → ${effect}`);
}
console.log(
  `\nThen: pnpm release:status ${tag} (docs/releasing.md → Steps, from step 4).\n` +
    `To undo before pushing: git tag -d ${tag} && git reset --hard HEAD~1`,
);
