/**
 * One table of what every release channel did for a tag — the pure half of
 * `scripts/release-status.mjs`, which fetches the runs with `gh api` and is
 * also run by `.github/workflows/release-summary.yml`.
 *
 * Everything here reads GitHub API shapes (a workflow run, its jobs and their
 * steps, a release) and returns text, so it is tested without a network
 * (`release-status.test.mjs`). The job and step names are the ones in the
 * workflow files; renaming one there turns its fact into "unknown" here,
 * never into a wrong answer.
 */

/**
 * The workflows a `vX.Y.Z` tag can have runs for, in the order a release
 * reaches people. `manual` says when a missing run is expected rather than a
 * sign that the tag push did not arrive.
 */
export const CHANNELS = Object.freeze([
  { channel: "Self-host images", workflow: "release", file: "release.yml", manual: null },
  { channel: "Browser extension", workflow: "Extension Release", file: "extension-release.yml", manual: null },
  { channel: "Desktop apps", workflow: "Desktop Release", file: "desktop-release.yml", manual: null },
  {
    channel: "Mobile apps",
    workflow: "Mobile Release",
    file: "mobile-release.yml",
    manual: "manual dispatch only",
  },
  {
    channel: "Package managers",
    workflow: "Desktop Manifests",
    file: "desktop-manifests.yml",
    manual: "run from the tag after the desktop release is published",
  },
]);

const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A release tag; anything else never reaches a `gh api` path. */
export const isReleaseTag = (tag) => typeof tag === "string" && TAG.test(tag);

/** `queued`, `in_progress`, … while running; the conclusion once completed. */
export const runState = (run) => {
  if (!run) return "not run";
  if (run.status !== "completed") return run.status.replace(/_/g, " ");
  return run.conclusion ?? "completed";
};

const jobsNamed = (jobs, prefix) => jobs.filter((job) => job.name === prefix || job.name.startsWith(`${prefix} `));
const stepOf = (jobs, name) => {
  for (const job of jobs) {
    const step = (job.steps ?? []).find((candidate) => candidate.name === name);
    if (step) return step;
  }
  return null;
};
const all = (jobs, conclusion) => jobs.length > 0 && jobs.every((job) => job.conclusion === conclusion);
const any = (jobs, conclusion) => jobs.some((job) => job.conclusion === conclusion);

/** release.yml: whether the images passed smoke and the floating tags moved. */
const selfHostFacts = (jobs) => {
  const facts = [];
  const smoke = jobsNamed(jobs, "smoke");
  const promote = jobsNamed(jobs, "promote");
  if (any(smoke, "failure")) facts.push("smoke failed (the first release: make the GHCR packages public, docs/releasing.md step 4)");
  else if (all(smoke, "success")) facts.push("smoke passed on both arches");
  if (all(promote, "success")) facts.push("GHCR X.Y/latest promoted");
  else if (any(promote, "failure")) facts.push("promote failed: X.Y/latest not moved");
  else if (promote.length > 0 && all(promote, "skipped")) facts.push("X.Y/latest not moved (promote skipped)");
  return facts;
};

/** extension-release.yml: whether the store upload ran, and why not. */
const extensionFacts = (jobs, annotations) => {
  const upload = stepOf(jobs, "Upload to the Chrome Web Store");
  if (!upload) return [];
  if (upload.conclusion === "success") return ["uploaded to the Chrome Web Store"];
  if (upload.conclusion === "failure") return ["Chrome Web Store upload failed"];
  if (upload.conclusion !== "skipped") return [];
  if (annotations.some((text) => /store upload skipped/.test(text))) return ["store upload skipped: no store secrets"];
  if (annotations.some((text) => /prerelease/.test(text))) return ["store upload skipped: prerelease"];
  return ["store upload skipped"];
};

/** desktop-release.yml: how many channels built, and the draft's state. */
const desktopFacts = (jobs, release) => {
  const facts = [];
  const legs = jobs.filter((job) => job.name !== "draft release");
  if (legs.length > 0) {
    facts.push(`${legs.filter((job) => job.conclusion === "success").length}/${legs.length} channels built`);
  }
  if (release === undefined) return facts;
  if (release === null) facts.push("no GitHub Release visible (a draft needs write access to see)");
  else if (release.draft) facts.push("draft release exists: publishing it is the desktop release");
  else facts.push("GitHub Release published");
  return facts;
};

/** mobile-release.yml: which store uploads ran. */
const mobileFacts = (jobs) => {
  const facts = [];
  for (const [step, label] of [
    ["Upload to Play Store (internal track)", "Play internal track"],
    ["Upload to TestFlight", "TestFlight"],
  ]) {
    const found = stepOf(jobs, step);
    if (found?.conclusion === "success") facts.push(`uploaded to ${label}`);
    else if (found?.conclusion === "skipped") facts.push(`${label} upload skipped`);
    else if (found?.conclusion === "failure") facts.push(`${label} upload failed`);
  }
  return facts;
};

/**
 * One table row.
 *
 * @param {object} channel          an entry of CHANNELS
 * @param {object | null} run       the newest run of that workflow for the tag
 * @param {object} extra
 * @param {object[]} [extra.jobs]   the run's jobs, with steps
 * @param {string[]} [extra.annotations]  annotation messages of those jobs
 * @param {object | null} [extra.release]  the tag's GitHub Release; undefined when not looked up
 * @param {boolean} [extra.missingWorkflow]  the workflow file is not on GitHub's default branch
 */
export const statusRow = (channel, run, { jobs = [], annotations = [], release, missingWorkflow = false } = {}) => {
  const facts = [];
  if (!run) {
    if (missingWorkflow) facts.push("workflow not on the default branch yet");
    else if (channel.manual) facts.push(channel.manual);
    else facts.push("expected a run for this tag");
  } else {
    if (run.event && run.event !== "push") facts.push(`started by ${run.event.replace(/_/g, " ")}`);
    if (run.run_attempt > 1) facts.push(`attempt ${run.run_attempt}`);
    if (channel.file === "release.yml") facts.push(...selfHostFacts(jobs));
    if (channel.file === "extension-release.yml") facts.push(...extensionFacts(jobs, annotations));
    if (channel.file === "mobile-release.yml") facts.push(...mobileFacts(jobs));
  }
  if (channel.file === "desktop-release.yml" && (run || release)) facts.push(...desktopFacts(jobs, release));
  return {
    channel: channel.channel,
    workflow: channel.workflow,
    state: runState(run),
    url: run?.html_url ?? "",
    facts,
  };
};

const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));

/** A plain-text table for a terminal. */
export const renderText = (tag, rows) => {
  const header = { channel: "Channel", workflow: "Workflow", state: "Result", facts: "Facts" };
  const facts = (row) => row.facts.join("; ");
  const widths = {
    channel: Math.max(header.channel.length, ...rows.map((row) => row.channel.length)),
    workflow: Math.max(header.workflow.length, ...rows.map((row) => row.workflow.length)),
    state: Math.max(header.state.length, ...rows.map((row) => row.state.length)),
  };
  const line = (row, factText, url) =>
    `${pad(row.channel, widths.channel)}  ${pad(row.workflow, widths.workflow)}  ${pad(row.state, widths.state)}  ${factText}${url ? `\n${" ".repeat(widths.channel + 2)}${url}` : ""}`;
  return [`Release ${tag}`, "", line(header, header.facts, ""), ...rows.map((row) => line(row, facts(row), row.url))].join(
    "\n",
  );
};

const STATE_MARK = { success: "✅", failure: "❌", cancelled: "⚪", skipped: "⚪", "not run": "·" };
const escapeCell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A Markdown table for GITHUB_STEP_SUMMARY. */
export const renderMarkdown = (tag, rows) =>
  [
    `### Release ${tag}`,
    "",
    "| Channel | Workflow | Result | Facts |",
    "|---|---|---|---|",
    ...rows.map((row) => {
      const state = `${STATE_MARK[row.state] ?? "⏳"} ${row.state}`;
      const result = row.url ? `[${state}](${row.url})` : state;
      return `| ${escapeCell(row.channel)} | ${escapeCell(row.workflow)} | ${result} | ${escapeCell(row.facts.join("; ") || "—")} |`;
    }),
    "",
    "Refreshed each time one of these workflows finishes for this tag (`release-summary.yml`); `pnpm release:status` prints the same table locally.",
  ].join("\n");
