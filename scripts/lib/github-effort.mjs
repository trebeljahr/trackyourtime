import { createHash } from "node:crypto";

const DAY = 86_400_000;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
};
const dayOf = (value) => new Date(value).toISOString().slice(0, 10);
const eraOf = (date, baselineCutoff, aiSurge) =>
  date < baselineCutoff ? "baseline" : date < aiSurge ? "transition" : "ai";

/** Hash the evidence, not generated timestamps. Re-running yields the same id. */
export const githubEffortId = (repository, date) =>
  createHash("sha256").update(`github-effort-v1:${repository}:${date}`).digest("hex").slice(0, 24);

/**
 * A relative change-size proxy, NOT hours or a lines-per-hour rule. Generated
 * files must be removed by the collector. A log scale limits giant imports.
 * Missing diffs stay explicit and get wider uncertainty downstream.
 */
export function commitEffortWeight(commit) {
  const stats = commit.stats;
  if (!stats) return 1;
  for (const field of ["files", "lines", "binary"]) {
    if (!Number.isSafeInteger(stats[field]) || stats[field] < 0) throw new Error("Invalid diff statistics");
  }
  if (stats.files === 0 && stats.binary === 0) return 0.15;
  return clamp(0.3 + Math.log2(1 + stats.lines) / 5 + Math.log2(1 + stats.files) / 4 + Math.min(2, stats.binary / 4), 0.15, 5);
}

/** Every date touched, including midnight-crossing and running entries. */
export function occupiedDays(entries, blockedDays = [], guardDays = 1, now = new Date().toISOString()) {
  if (!Number.isInteger(guardDays) || guardDays < 0 || guardDays > 2) throw new Error("Invalid date guard");
  const result = new Set();
  const add = (from, to) => {
    const first = Date.parse(`${dayOf(from)}T00:00:00Z`) - guardDays * DAY;
    const last = Date.parse(`${dayOf(to)}T00:00:00Z`) + guardDays * DAY;
    if (last - first > 10 * 366 * DAY) throw new Error("Implausible tracked interval");
    for (let ms = first; ms <= last; ms += DAY) result.add(dayOf(ms));
  };
  for (const entry of entries) add(entry.start, entry.end ?? now);
  for (const day of blockedDays) add(day, day);
  return result;
}

/**
 * Offline planning only. Callers collect ONLY explicitly allowed personal
 * repositories and personal entries. No credentials, network or writes here.
 *
 * Input commits are authored contributions, with merges/bots excluded by the
 * collector. repositoryProjects maps an explicit repository allowlist to the
 * project's name. Existing reconstructed entries are never calibration data.
 */
export function planGithubEffort(input) {
  const { commits, entries, projects, repositoryProjects, reconstructedTagIds = [], blockedDays = [],
    baselineCutoff = "2023-01-01", aiSurge = "2026-01-01", guardDays = 1 } = input;
  if (!Array.isArray(commits) || !Array.isArray(entries) || !Array.isArray(projects)) throw new Error("Missing evidence");
  if (!Number.isFinite(Date.parse(baselineCutoff)) || !Number.isFinite(Date.parse(aiSurge)) || baselineCutoff >= aiSurge) throw new Error("Invalid era boundaries");
  const ownClientIds = new Set(input.personalClientIds ?? []);
  for (const p of projects) {
    if (p.billableDefault !== false || (p.clientId != null && !ownClientIds.has(p.clientId))) throw new Error("Client or billable project in personal evidence");
  }
  const allowedProjectIds = new Set(projects.map((p) => p._id));
  for (const e of entries) {
    if (e.billable !== false || e.invoiceId || (e.clientId != null && !ownClientIds.has(e.clientId)) || (e.projectId != null && !allowedProjectIds.has(e.projectId))) throw new Error("Client or billable entry in personal evidence");
    if (!Number.isFinite(Date.parse(e.start)) || (e.end != null && (!Number.isFinite(Date.parse(e.end)) || Date.parse(e.end) < Date.parse(e.start))) || !Number.isFinite(e.durationSec) || e.durationSec < 0) throw new Error("Invalid tracked interval");
  }
  const projectsById = new Map(projects.map((p) => [p._id, p.name]));
  const seen = new Set();
  const days = new Map();
  let duplicateCommits = 0;
  for (const c of [...commits].sort((a, b) => a.repository.localeCompare(b.repository) || a.date.localeCompare(b.date) || a.sha.localeCompare(b.sha))) {
    const project = repositoryProjects[c.repository];
    if (!project) throw new Error(`Repository not explicitly allowed: ${c.repository}`);
    if (!/^[a-f0-9]{40}$/.test(c.sha) || !Number.isFinite(Date.parse(c.date))) throw new Error("Invalid commit evidence");
    if (seen.has(c.sha)) { duplicateCommits++; continue; }
    seen.add(c.sha);
    const date = dayOf(c.date);
    const key = `${c.repository}:${date}`;
    if (!days.has(key)) days.set(key, { repository: c.repository, project, date, commits: [], weight: 0 });
    const group = days.get(key);
    const weight = commitEffortWeight(c);
    group.commits.push({ ...c, weight });
    group.weight += weight;
  }
  const reconstructed = new Set(reconstructedTagIds);
  const actualByProjectDay = new Map();
  const dailyActual = new Map();
  for (const e of entries) {
    if (!e.end || e.durationSec <= 0 || e.durationSec > 12 * 3600 || e.tagIds?.some((id) => reconstructed.has(id))) continue;
    const project = projectsById.get(e.projectId);
    if (!project) continue;
    const day = dayOf(e.start);
    // Overnight entries cannot be reliably matched to one commit date.
    if (day !== dayOf(e.end)) continue;
    const key = `${project}:${day}`;
    actualByProjectDay.set(key, (actualByProjectDay.get(key) ?? 0) + e.durationSec / 3600);
    dailyActual.set(day, (dailyActual.get(day) ?? 0) + e.durationSec / 3600);
  }
  const groupedByProjectDay = new Map();
  for (const g of days.values()) {
    const key = `${g.project}:${g.date}`;
    groupedByProjectDay.set(key, (groupedByProjectDay.get(key) ?? 0) + g.weight);
  }
  const samples = { baseline: [], transition: [], ai: [] };
  for (const [key, weight] of groupedByProjectDay) {
    const hours = actualByProjectDay.get(key);
    const date = key.slice(-10);
    if (hours == null || hours < 0.5 || hours > 12) continue;
    samples[eraOf(date, baselineCutoff, aiSurge)].push({ date, project: key.slice(0, -11), hours, weight, ratio: hours / weight });
  }
  if (samples.baseline.length < 8) throw new Error("Need at least eight matched pre-AI personal project-days for calibration");
  const factors = {};
  const calibration = {};
  for (const era of ["baseline", "transition", "ai"]) {
    const usable = samples[era];
    // Recent work is calibrated independently. If absent, retain the baseline
    // as an explicit fallback, never invent an AI speed multiplier.
    const fallback = usable.length < 8;
    const data = fallback ? samples.baseline : usable;
    factors[era] = quantile(data.map((s) => s.ratio), 0.5);
    calibration[era] = { sampleCount: usable.length, fallbackToBaseline: fallback, hoursPerWeight: factors[era], samples: usable };
  }
  const baselineDays = [...dailyActual].filter(([day]) => day < baselineCutoff).map(([, hours]) => hours).filter((h) => h > 0 && h <= 12);
  const dailyCapHours = clamp(quantile(baselineDays, 0.9) ?? 8, 6, 10);
  const totalsByDay = new Map();
  for (const g of days.values()) {
    g.era = eraOf(g.date, baselineCutoff, aiSurge);
    g.rawHours = g.weight * factors[g.era];
    totalsByDay.set(g.date, (totalsByDay.get(g.date) ?? 0) + g.rawHours);
  }
  const occupied = occupiedDays(entries, blockedDays, guardDays, input.now);
  const projectDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.repository.localeCompare(b.repository)).map((g) => {
    const scale = Math.min(1, dailyCapHours / totalsByDay.get(g.date));
    const hours = g.rawHours * scale;
    const missingDiffs = g.commits.some((c) => !c.stats);
    const ratios = samples[g.era].map((s) => s.ratio / factors[g.era]);
    // Plausible ranges, NOT confidence intervals. Sparse history, missing
    // diffs, and AI-era commits all make the bounds deliberately wider.
    const minLow = g.era === "ai" ? 0.2 : missingDiffs ? 0.3 : 0.4;
    const minHigh = g.era === "ai" ? 3.5 : missingDiffs ? 3 : 2.5;
    const lowFactor = Math.min(minLow, quantile(ratios, 0.1) ?? minLow);
    const highFactor = Math.max(minHigh, quantile(ratios, 0.9) ?? minHigh);
    const lowHours = hours * lowFactor;
    // No automatic cap on the upper range: a daily cap is a conservative
    // import policy, not evidence that long human sessions never happened.
    const highHours = Math.max(hours, hours * highFactor);
    const covered = occupied.has(g.date);
    return { id: githubEffortId(g.repository, g.date), repository: g.repository, project: g.project,
      date: g.date, era: g.era, hours, lowHours, highHours, status: covered ? "covered-date-no-addition" : "uncovered-date",
      missingDiffs, dailyCapApplied: scale < 1,
      commits: g.commits.map((c) => ({ sha: c.sha, date: c.date, subject: c.subject,
        hours: hours * c.weight / g.weight, lowHours: lowHours * c.weight / g.weight,
        highHours: highHours * c.weight / g.weight, hasDiffStats: Boolean(c.stats) })) };
  });
  // One synthetic bookkeeping block per repo-day, globally serialized. It is
  // explicitly labelled as inferred placement, never a timestamp observation.
  const cursors = new Map();
  const newEntries = [];
  for (const g of projectDays) {
    if (g.status !== "uncovered-date") continue;
    const start = cursors.get(g.date) ?? Date.parse(`${g.date}T08:00:00Z`);
    const durationSec = Math.floor(g.hours * 3600);
    if (durationSec < 60) continue;
    const end = start + durationSec * 1000;
    cursors.set(g.date, end);
    newEntries.push({ id: g.id, project: g.project, repository: g.repository, date: g.date,
      start: new Date(start).toISOString(), end: new Date(end).toISOString(), durationSec,
      lowSec: Math.floor(g.lowHours * 3600), highSec: Math.ceil(g.highHours * 3600),
      description: `GitHub estimate: ${g.repository}; ${g.commits.length} commits; likely ${g.hours.toFixed(2)}h (plausible ${g.lowHours.toFixed(2)}–${g.highHours.toFixed(2)}h). Not timed; calendar placement inferred. ${g.commits[0].sha.slice(0, 10)}` });
  }
  const names = new Set(projectDays.map((g) => g.project));
  const projectEstimates = [...names].sort().map((project) => {
    const existingSec = sum(entries.filter((e) => projectsById.get(e.projectId) === project).map((e) => e.durationSec));
    const additions = newEntries.filter((e) => e.project === project);
    const modeledDays = projectDays.filter((g) => g.project === project);
    const existingByDay = new Map();
    for (const e of entries.filter((e) => projectsById.get(e.projectId) === project)) {
      // Allocate actual elapsed time across UTC days, scaling by durationSec
      // for old imports whose stored duration differs slightly from the span.
      const from = Date.parse(e.start), to = Date.parse(e.end ?? e.start);
      if (to <= from) continue;
      for (let cursor = Math.floor(from / DAY) * DAY; cursor < to; cursor += DAY) {
        const part = Math.max(0, Math.min(to, cursor + DAY) - Math.max(from, cursor));
        const date = dayOf(cursor);
        existingByDay.set(date, (existingByDay.get(date) ?? 0) + e.durationSec / 3600 * part / (to - from));
      }
    }
    // Project estimates describe the possible whole build, independently of
    // what it was safe to add to the time log. Never use "no addition" as
    // evidence that a project took zero hours. Existing project-day time is
    // credited first, so it is not added to the model a second time.
    const residual = (field) => sum(modeledDays.map((g) => Math.max(0, g[field] - (existingByDay.get(g.date) ?? 0))));
    const modeledHours = existingSec / 3600 + residual("hours");
    return { project, existingHours: existingSec / 3600, addedHours: sum(additions.map((e) => e.durationSec)) / 3600,
      loggedHoursAfterImport: (existingSec + sum(additions.map((e) => e.durationSec))) / 3600,
      estimatedHours: modeledHours,
      lowHours: existingSec / 3600 + residual("lowHours"),
      highHours: existingSec / 3600 + residual("highHours"),
      unloggedEstimatedHours: Math.max(0, modeledHours - (existingSec + sum(additions.map((e) => e.durationSec))) / 3600),
      includesAmbiguousCoveredDates: modeledDays.some((g) => g.status === "covered-date-no-addition" && !existingByDay.has(g.date)),
      commitCount: sum(modeledDays.map((g) => g.commits.length)) };
  });
  return { version: 1, method: "github-effort-v1", baselineCutoff, aiSurge, guardDays,
    rangeMeaning: "Plausible uncertainty bounds, not statistical confidence intervals. Commit shares within a day are correlated, not independent measurements. Existing time is held fixed, including earlier reconstructions. Covered dates mean no time added; a tag does not prove a commit was timed.",
    dailyCapHours, calibration, duplicateCommits, projectDays, newEntries, projectEstimates };
}
