#!/usr/bin/env node
/**
 * What every release channel did for a tag, as one table.
 *
 *   pnpm release:status [vX.Y.Z] [--markdown]
 *
 * Default tag: the newest local `v*` tag. Reads only, through `gh api`: the
 * newest run of each tag workflow (`CHANNELS` in scripts/lib/release-status.mjs),
 * its jobs and steps, and the tag's GitHub Release. Locally that is your `gh`
 * login; in `.github/workflows/release-summary.yml` it is the workflow's
 * read-only token, with `--markdown` for the step summary.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANNELS, isReleaseTag, renderMarkdown, renderText, statusRow } from "./lib/release-status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (message) => {
  console.error(`release:status: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const markdown = args.includes("--markdown");
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--markdown");
if (unknown.length > 0 || positional.length > 1) fail("usage: pnpm release:status [vX.Y.Z] [--markdown]");

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();

let tag = positional[0];
if (tag === undefined) {
  tag = git("tag", "-l", "v*", "--sort=-v:refname").split("\n").find(isReleaseTag);
  if (!tag) fail("no local v* tag; pass one, e.g. pnpm release:status v0.1.0");
}
if (!isReleaseTag(tag)) fail(`"${tag}" is not a vX.Y.Z tag`);

/** owner/name, from Actions or from the origin remote. */
const repository = (() => {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git("remote", "get-url", "origin");
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) fail(`origin (${url}) is not a GitHub remote; set GITHUB_REPOSITORY=owner/name`);
  return match[1];
})();

/** A GET through `gh api`; null on 404 (or 403 when `optional`). */
const api = (path, { optional = false } = {}) => {
  const result = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`could not run gh (${result.error.message}); install the GitHub CLI and run gh auth login`);
  if (result.status === 0) return JSON.parse(result.stdout);
  const detail = `${result.stdout}${result.stderr}`;
  if (/HTTP 404/.test(detail)) return null;
  if (optional && /HTTP 403/.test(detail)) return null;
  fail(`gh api ${path} failed:\n${detail.trim()}`);
};

const encodedTag = encodeURIComponent(tag);
const releases = api(`repos/${repository}/releases?per_page=100`, { optional: true });
const release = releases === null ? null : (releases.find((candidate) => candidate.tag_name === tag) ?? null);

const rows = CHANNELS.map((channel) => {
  const runs = api(`repos/${repository}/actions/workflows/${channel.file}/runs?branch=${encodedTag}&per_page=20`);
  if (runs === null) return statusRow(channel, null, { missingWorkflow: true, release });
  // Newest first; a re-run keeps its run id and raises run_attempt.
  const run = runs.workflow_runs.find((candidate) => candidate.head_branch === tag) ?? null;
  if (run === null) return statusRow(channel, null, { release });

  const jobs = api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)?.jobs ?? [];
  // Annotations say WHY a step was skipped (the extension's store upload).
  // They need checks: read, which the summary workflow does not ask for, so a
  // refusal only makes that one fact less specific.
  const annotations =
    channel.file === "extension-release.yml"
      ? jobs.flatMap(
          (job) =>
            api(`repos/${repository}/check-runs/${job.id}/annotations`, { optional: true })?.map(
              (annotation) => annotation.message ?? "",
            ) ?? [],
        )
      : [];
  return statusRow(channel, run, { jobs, annotations, release });
});

console.log(markdown ? renderMarkdown(tag, rows) : renderText(tag, rows));
