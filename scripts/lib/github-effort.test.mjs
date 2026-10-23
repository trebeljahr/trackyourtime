import assert from "node:assert/strict";
import test from "node:test";
import { planGithubEffort, occupiedDays, githubEffortId } from "./github-effort.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
const fixture = () => ({
  repositoryProjects: { toy: "Toy", other: "Other" }, personalClientIds: ["self"], guardDays: 0,
  reconstructedTagIds: ["inferred"],
  projects: [{ _id: "p", name: "Toy", clientId: "self", billableDefault: false }],
  commits: Array.from({ length: 9 }, (_, i) => ({ repository: "toy", sha: sha(i + 1), date: `2022-01-${String(i + 1).padStart(2, "0")}T12:00:00Z`, subject: "Build toy", stats: { files: 2, lines: 40, binary: 0 } })),
  entries: Array.from({ length: 8 }, (_, i) => ({ projectId: "p", clientId: "self", billable: false, durationSec: 3600,
    start: `2022-01-${String(i + 1).padStart(2, "0")}T09:00:00Z`, end: `2022-01-${String(i + 1).padStart(2, "0")}T10:00:00Z` })),
});

test("covered dates are estimated in the audit but never logged again", () => {
  const plan = planGithubEffort(fixture());
  assert.equal(plan.calibration.baseline.sampleCount, 8);
  assert.equal(plan.newEntries.length, 1);
  assert.equal(plan.newEntries[0].date, "2022-01-09");
  assert.equal(plan.projectDays.filter((d) => d.status === "covered-date-no-addition").length, 8);
  assert.equal(plan.projectEstimates[0].existingHours, 8);
});

test("fork and branch duplicate SHAs count once; IDs survive expanded evidence", () => {
  const input = fixture(); input.commits.push({ ...input.commits[8], repository: "other" });
  const plan = planGithubEffort(input);
  assert.equal(plan.duplicateCommits, 1);
  assert.equal(plan.projectDays.flatMap((d) => d.commits).length, 9);
  assert.equal(githubEffortId("toy", "2022-01-09"), githubEffortId("toy", "2022-01-09"));
});

test("global daily cap serializes multiple projects without overlapping time", () => {
  const input = fixture();
  for (let i = 20; i < 120; i++) input.commits.push({ ...input.commits[8], sha: sha(i), repository: i % 2 ? "other" : "toy" });
  const p = planGithubEffort(input);
  assert.ok(p.newEntries.reduce((sum, e) => sum + e.durationSec, 0) <= p.dailyCapHours * 3600);
  const entries = p.newEntries.sort((a, b) => a.start.localeCompare(b.start));
  assert.ok(entries[0].end <= entries[1].start);
  for (const d of p.projectDays) assert.ok(Math.abs(d.commits.reduce((s, c) => s + c.hours, 0) - d.hours) < 1e-8);
});

test("blocked work dates and neighboring dates cannot receive estimates", () => {
  const input = fixture(); input.blockedDays = ["2022-01-10"]; input.guardDays = 1;
  assert.equal(planGithubEffort(input).newEntries.length, 0);
  assert.ok(occupiedDays([{ start: "2022-01-08T23:00:00Z", end: "2022-01-09T02:00:00Z" }], [], 0).has("2022-01-09"));
});

test("previous inferred time cannot calibrate estimates; insufficient real data fails closed", () => {
  const input = fixture(); input.entries[0].tagIds = ["inferred"];
  assert.throws(() => planGithubEffort(input), /at least eight/);
});

test("client work and non-allowlisted repositories are refused", () => {
  for (const mutate of [
    (i) => { i.entries[0].billable = true; },
    (i) => { i.projects[0].clientId = "client"; },
    (i) => { i.commits[0].repository = "client-repository"; },
    (i) => { i.commits[0].stats.lines = Number.NaN; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planGithubEffort(input)); }
});

test("AI-era estimates have explicitly wide plausible ranges and sparse calibration is labelled", () => {
  const input = fixture(); input.commits[8].date = "2026-02-01T12:00:00Z";
  const plan = planGithubEffort(input);
  const day = plan.projectDays.at(-1);
  assert.equal(day.era, "ai");
  assert.equal(plan.calibration.ai.fallbackToBaseline, true);
  assert.ok(day.lowHours <= day.hours * 0.2);
  assert.ok(day.highHours >= day.hours * 3.5);
});

test("re-running after insertion creates no additional records", () => {
  const input = fixture();
  const first = planGithubEffort(input);
  for (const e of first.newEntries) input.entries.push({ ...e, _id: e.id, projectId: "p", clientId: "self", billable: false, tagIds: ["inferred"] });
  assert.equal(planGithubEffort(input).newEntries.length, 0);
});

test("an occupied date does not falsely make an untracked project's estimate zero", () => {
  const input = fixture();
  input.commits.push({ ...input.commits[0], repository: "other", sha: sha(100) });
  const plan = planGithubEffort(input);
  const project = plan.projectEstimates.find((p) => p.project === "Other");
  assert.equal(project.addedHours, 0);
  assert.ok(project.estimatedHours > 0);
  assert.ok(project.unloggedEstimatedHours > 0);
  assert.equal(project.includesAmbiguousCoveredDates, true);
});
