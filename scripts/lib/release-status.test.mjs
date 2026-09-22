/**
 * The release status table (scripts/lib/release-status.mjs) against made-up
 * GitHub API answers, plus a read of the workflow files so a renamed job or
 * step fails here instead of quietly dropping a fact from every summary.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANNELS, isReleaseTag, renderMarkdown, renderText, runState, statusRow } from "./release-status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = (file) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");
const channel = (file) => {
  const found = CHANNELS.find((candidate) => candidate.file === file);
  assert.ok(found, file);
  return found;
};
const run = (overrides = {}) => ({
  status: "completed",
  conclusion: "success",
  event: "push",
  run_attempt: 1,
  html_url: "https://github.com/o/r/actions/runs/1",
  ...overrides,
});
const job = (name, conclusion, steps = []) => ({ name, conclusion, steps });

describe("release status", () => {
  it("accepts release tags only", () => {
    assert.ok(isReleaseTag("v0.1.0"));
    assert.ok(isReleaseTag("v1.2.3-rc.1"));
    assert.equal(isReleaseTag("main"), false);
    assert.equal(isReleaseTag("v1.2"), false);
    assert.equal(isReleaseTag("v1.2.3;rm -rf"), false);
  });

  it("reports running, completed and missing runs", () => {
    assert.equal(runState(null), "not run");
    assert.equal(runState(run({ status: "in_progress", conclusion: null })), "in progress");
    assert.equal(runState(run({ conclusion: "failure" })), "failure");
  });

  it("says whether a missing run was expected", () => {
    assert.deepEqual(statusRow(channel("release.yml"), null).facts, ["expected a run for this tag"]);
    assert.deepEqual(statusRow(channel("mobile-release.yml"), null).facts, ["manual dispatch only"]);
    assert.deepEqual(statusRow(channel("extension-release.yml"), null, { missingWorkflow: true }).facts, [
      "workflow not on the default branch yet",
    ]);
  });

  it("reads smoke and promote from the release run", () => {
    const promoted = statusRow(channel("release.yml"), run(), {
      jobs: [job("smoke (amd64)", "success"), job("smoke (arm64)", "success"), job("promote (server)", "success")],
    });
    assert.deepEqual(promoted.facts, ["smoke passed on both arches", "GHCR X.Y/latest promoted"]);
    const first = statusRow(channel("release.yml"), run({ conclusion: "failure" }), {
      jobs: [job("smoke (amd64)", "failure"), job("promote (server)", "skipped")],
    });
    assert.match(first.facts[0], /smoke failed/);
    assert.equal(first.facts[1], "X.Y/latest not moved (promote skipped)");
  });

  it("says why the store upload was skipped", () => {
    const skipped = [job("chrome-web-store", "success", [{ name: "Upload to the Chrome Web Store", conclusion: "skipped" }])];
    const ext = channel("extension-release.yml");
    assert.deepEqual(
      statusRow(ext, run(), {
        jobs: skipped,
        annotations: ["CWS_SERVICE_ACCOUNT_JSON and CWS_PUBLISHER_ID are not set — built and zipped, store upload skipped."],
      }).facts,
      ["store upload skipped: no store secrets"],
    );
    assert.deepEqual(statusRow(ext, run(), { jobs: skipped }).facts, ["store upload skipped"]);
    const uploaded = [job("chrome-web-store", "success", [{ name: "Upload to the Chrome Web Store", conclusion: "success" }])];
    assert.deepEqual(statusRow(ext, run(), { jobs: uploaded }).facts, ["uploaded to the Chrome Web Store"]);
  });

  it("reads the Play upload step whatever track the plan chose", () => {
    const mob = channel("mobile-release.yml");
    const jobs = (conclusion) => [
      job("android", "success", [{ name: "Upload to Google Play (beta)", conclusion }]),
      job("ios", "success", [{ name: "Upload to TestFlight", conclusion: "skipped" }]),
    ];
    assert.deepEqual(statusRow(mob, run(), { jobs: jobs("success") }).facts, [
      "uploaded to Play",
      "TestFlight upload skipped",
    ]);
    assert.deepEqual(statusRow(mob, run(), { jobs: jobs("failure") }).facts[0], "Play upload failed");
  });

  it("counts desktop channels and reads the draft", () => {
    const desk = channel("desktop-release.yml");
    const jobs = [job("mac", "success"), job("win", "failure"), job("draft release", "skipped")];
    assert.deepEqual(statusRow(desk, run(), { jobs, release: { draft: true } }).facts, [
      "1/2 channels built",
      "draft release exists: publishing it is the desktop release",
    ]);
    assert.deepEqual(statusRow(desk, run(), { jobs: [], release: { draft: false } }).facts, ["GitHub Release published"]);
    assert.deepEqual(statusRow(desk, null, { release: null }).facts, ["expected a run for this tag"]);
  });

  it("notes a dispatched or re-run run", () => {
    const row = statusRow(channel("desktop-manifests.yml"), run({ event: "workflow_dispatch", run_attempt: 2 }));
    assert.deepEqual(row.facts, ["started by workflow dispatch", "attempt 2"]);
  });

  it("renders a text and a markdown table", () => {
    const rows = [statusRow(channel("release.yml"), run()), statusRow(channel("mobile-release.yml"), null)];
    const text = renderText("v0.1.0", rows);
    assert.match(text, /^Release v0\.1\.0\n\nChannel +Workflow +Result +Facts\n/);
    assert.match(text, /https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
    const md = renderMarkdown("v0.1.0", rows);
    assert.match(md, /\| Self-host images \| release \| \[✅ success\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\) \| — \|/);
    assert.match(md, /\| Mobile apps \| Mobile Release \| · not run \| manual dispatch only \|/);
  });
});

describe("the workflow files", () => {
  it("each channel's workflow exists under the name the summary listens for", () => {
    const summary = workflow("release-summary.yml");
    for (const { file, workflow: name } of CHANNELS) {
      assert.match(workflow(file), new RegExp(`^name: ${name}$`, "m"), file);
      assert.ok(summary.includes(`- ${name}\n`), `release-summary.yml listens for ${name}`);
    }
  });

  it("the jobs and steps the facts are read from still exist", () => {
    assert.match(workflow("release.yml"), /^ {2}smoke:$/m);
    assert.match(workflow("release.yml"), /^ {2}promote:$/m);
    assert.match(workflow("extension-release.yml"), /- name: Upload to the Chrome Web Store$/m);
    assert.match(workflow("extension-release.yml"), /store upload skipped/);
    assert.match(workflow("desktop-release.yml"), /^ {4}name: draft release$/m);
    assert.match(workflow("mobile-release.yml"), /- name: Upload to Google Play \(/m);
    assert.match(workflow("mobile-release.yml"), /- name: Upload to TestFlight$/m);
  });
});
