/*
 * Conformance cases for `tyt-activity`'s port of packages/core/src/activity.
 *
 * The browser extension keeps running the TypeScript, and the desktop app
 * now runs the Rust copy, so the two must answer the same rows identically.
 * This runs the TypeScript over hand-picked edge cases and seeded random ones
 * and writes inputs and outputs as JSON; `tests/conformance.rs` replays every
 * case against the Rust functions. `check.mjs` regenerates into a temporary
 * directory and fails when the committed files differ, so a change to the
 * TypeScript that the Rust does not follow is caught.
 *
 *   node --import tsx desktop/crates/activity/fixtures/generate.mts [outDir]
 *
 * Deterministic: a fixed-seed PRNG, no clock.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildSuggestions,
  createFilingResolver,
  decideAutopilot,
  filingKeyOf,
  hadBreakSince,
  hostMatches,
  isFileable,
  lastBreakEnd,
  learnFilings,
  matchRule,
  mergeSegments,
  normalizeHostPattern,
  ruleProposal,
  subtractIntervals,
  totalLength,
  trailingRun,
  trailingStreak,
  unionIntervals,
  DEFAULT_AUTOPILOT_OPTIONS,
  type ActivityInterval,
  type ActivityRule,
  type ActivitySegment,
  type AutopilotFiling,
  type AutopilotRunning,
  type LabelledPiece,
  type LearnableEntry,
} from "../../../../packages/core/src/activity/index.ts";

const outDir = process.argv[2] ?? import.meta.dirname;

// ── a seeded PRNG (mulberry32) ────────────────────────────────────────
let seed = 0x7a17_2026;
const random = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const chance = (p: number): boolean => random() < p;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 8, 0, 0);

type Case = { fn: string; input: unknown; output: unknown };
const files: Record<string, Case[]> = { segments: [], rules: [], suggest: [], autopilot: [] };
const add = (file: keyof typeof files, fn: string, input: unknown, output: unknown): void => {
  // A JSON round trip drops `undefined` exactly as the bridge does.
  files[file]!.push(JSON.parse(JSON.stringify({ fn, input, output })) as Case);
};

// ── random inputs ─────────────────────────────────────────────────────
const KEYS = [
  "docs.test",
  "code.test",
  "chat.test",
  "com.figma.desktop",
  "com.microsoft.vscode",
  "com.google.chrome",
  "com.tinyspeck.slackmacgap",
  "Ünïcode.App",
  "\u{1F600}.app",
  "\uFF5E.app",
  "exe-my tool",
];
const LABELS = [undefined, "First", "Second", "report.md — Editor", "\u{1F600}"];

/** A time on a grid of `step` ms, inside the 4 hours after T0. */
const instant = (step: number): number => T0 + int(-30, 240) * MIN + int(0, Math.floor(MIN / step) - 1) * step;

const randomSegments = (count: number, options: { desktop?: boolean; step?: number } = {}): ActivitySegment[] =>
  Array.from({ length: count }, () => {
    const start = instant(options.step ?? 1000);
    const length = chance(0.1) ? 0 : chance(0.05) ? -int(1, 5) * 1000 : int(1, 40) * (chance(0.3) ? 30_000 : MIN) + (chance(0.2) ? 500 : 0);
    const label = pick(LABELS);
    return {
      source: options.desktop === true ? "desktop" : chance(0.85) ? "browser" : "desktop",
      start,
      end: start + length,
      key: pick(KEYS),
      ...(label !== undefined ? { label } : {}),
      afk: chance(0.08),
    } satisfies ActivitySegment;
  });

const randomIntervals = (count: number): ActivityInterval[] =>
  Array.from({ length: count }, () => {
    const start = instant(1000);
    return { start, end: start + (chance(0.1) ? 0 : int(1, 60) * MIN) };
  });

const PATTERNS = ["*.test", "code.test", "com.example.*", "*", "docs.*", "com.figma.desktop", "*.vscode", "ünïcode.*", "\u{1F600}*", "c*e.test"];
const randomRules = (count: number): ActivityRule[] =>
  Array.from({ length: count }, (_, i) => {
    const rule: ActivityRule = { id: `r${i}`, pattern: pick(PATTERNS) };
    if (chance(0.6)) rule.description = pick(["Website redesign", "API work", "  Review  ", "", "Research"]);
    if (chance(0.5)) rule.projectId = pick(["p-web", "p-api", null]);
    if (chance(0.3)) rule.taskId = pick(["t-1", null]);
    if (chance(0.3)) rule.tagIds = pick([[], ["g"], ["a", "b"]]);
    if (chance(0.3)) rule.billable = chance(0.5);
    return rule;
  });

// ── segments.ts ───────────────────────────────────────────────────────
const seg = (key: string, startMin: number, endMin: number, extra: Partial<ActivitySegment> = {}): ActivitySegment => ({
  source: "browser",
  start: T0 + startMin * MIN,
  end: T0 + endMin * MIN,
  key,
  afk: false,
  ...extra,
});

const mergeCases: { segments: ActivitySegment[]; options?: { pulseGapMs?: number } }[] = [
  { segments: [seg("a.test", 0, 5), { ...seg("a.test", 5, 10), start: T0 + 5 * MIN + 30_000 }] },
  { segments: [seg("a.test", 0, 5), seg("a.test", 7, 10)] },
  { segments: [seg("a.test", 0, 5), seg("a.test", 7, 10)], options: { pulseGapMs: 3 * MIN } },
  { segments: [seg("a.test", 0, 5), seg("a.test", 7, 10)], options: { pulseGapMs: 0 } },
  { segments: [seg("a.test", 0, 5), seg("b.test", 5, 10), seg("a.test", 10, 15, { source: "desktop" }), seg("a.test", 15, 20, { afk: true })] },
  { segments: [seg("a.test", 0, 5, { label: "First" }), seg("a.test", 5, 10, { label: "Second" }), seg("a.test", 20, 20)] },
  { segments: [seg("a.test", 0, 5), seg("a.test", 6, 8, { label: "late" })] },
  { segments: [] },
];
for (let i = 0; i < 60; i += 1) {
  mergeCases.push({
    segments: randomSegments(int(1, 25)),
    ...(chance(0.3) ? { options: { pulseGapMs: pick([0, 1000, 30_000, 5 * MIN]) } } : {}),
  });
}
for (const input of mergeCases) add("segments", "mergeSegments", input, mergeSegments(input.segments, input.options));

for (let i = 0; i < 40; i += 1) {
  const intervals = randomIntervals(int(0, 12));
  const union = unionIntervals(intervals);
  add("segments", "unionIntervals", { intervals }, union);
  add("segments", "totalLength", { union }, totalLength(union));
  const interval = randomIntervals(1)[0] as ActivityInterval;
  add("segments", "subtractIntervals", { interval, holes: union }, subtractIntervals(interval, union));
}

// ── rules.ts ──────────────────────────────────────────────────────────
const hostInputs = [
  " https://Docs.Example.com:8080/a/b ",
  "example.com.",
  "example.com..",
  "host:abc",
  "host:123",
  "host:",
  "a://b://c",
  "",
  "   ",
  "HTTP://X.Y/",
  "\uFEFFfoo\u0085",
  "\u00A0Bar\u3000",
  "İstanbul",
  "ΣΑΣ",
  "Track Your Time.exe",
  "C:\\Tools\\x.exe",
  "*.Example.COM",
  "docs.example.com:8080",
  "[::1]:80",
  "a\nb",
];
for (const input of hostInputs) add("rules", "normalizeHostPattern", { input }, normalizeHostPattern(input));

const matchPairs: [string, string][] = [
  ["example.com", "example.com"],
  ["example.com", "docs.example.com"],
  ["*.example.com", "docs.example.com"],
  ["*.example.com", "example.com"],
  ["*.example.com", "badexample.com"],
  ["docs.*", "docs.example.com"],
  ["EXAMPLE.com", "example.COM"],
  ["exa?ple.com", "example.com"],
  ["exa?ple.com", "exa?ple.com"],
  ["", "example.com"],
  ["*", ""],
  ["*", "anything"],
  ["a*b", "a\nb"],
  ["a*", "a\u2028"],
  ["a.c", "abc"],
  ["(x)", "(x)"],
  ["a+", "aa"],
  ["$a^", "$a^"],
  ["[ab]", "a"],
  ["[ab]", "[ab]"],
  ["\\d", "\\d"],
  ["c*e.test", "code.test"],
  ["**", "x"],
  ["https://example.com/path", "example.com"],
  ["ünïcode.*", "Ünïcode.App"],
  ["\u{1F600}*", "\u{1F600}.app"],
  ["*.app", "\u{1F600}.app"],
  ["com.jetbrains.*", "com.jetbrains.intellij"],
];
for (let i = 0; i < 60; i += 1) matchPairs.push([pick(PATTERNS), pick(KEYS)]);
for (const [pattern, host] of matchPairs) add("rules", "hostMatches", { pattern, host }, hostMatches(pattern, host));

for (let i = 0; i < 30; i += 1) {
  const rules = randomRules(int(0, 6));
  const keysByTime = Array.from({ length: int(0, 4) }, () => pick(KEYS));
  const rule = matchRule(rules, keysByTime);
  add("rules", "matchRule", { rules, keysByTime }, rule === null ? null : rule.id);
  for (const one of rules) add("rules", "ruleProposal", { rule: one }, ruleProposal(one));
}

// ── suggest.ts ────────────────────────────────────────────────────────
for (let i = 0; i < 80; i += 1) {
  const segments = randomSegments(int(1, 30), { step: pick([1000, 500, 250]) });
  const tracked = randomIntervals(int(0, 6));
  const rules = randomRules(int(0, 4));
  const options = chance(0.4)
    ? {
        ...(chance(0.5) ? { gapMinutes: pick([0, 2, 5, 15]) } : {}),
        ...(chance(0.5) ? { minMinutes: pick([0, 1, 4, 10]) } : {}),
        ...(chance(0.5) ? { maxKeys: pick([0, 1, 3, 10]) } : {}),
      }
    : undefined;
  add("suggest", "buildSuggestions", { segments, tracked, rules, options }, buildSuggestions(segments, tracked, rules, options));
}
{
  // A tie on purpose: 1.5 s rounds up, like Math.round.
  const segments = [seg("a.test", 0, 10), { ...seg("b.test", 10, 10), end: T0 + 10 * MIN + 1500 }];
  add("suggest", "buildSuggestions", { segments, tracked: [], rules: [], options: { minMinutes: 0 } }, buildSuggestions(segments, [], [], { minMinutes: 0 }));
}

// ── autopilot.ts ──────────────────────────────────────────────────────
const descriptions = ["  Website   Redesign ", "website redesign", "\u00A0Tab\tbed\n", "ÄÖÜ", "\u{1F600} x", 'quote " and \\', "ctl \u0001", "line\u2028sep", "", "   "];
for (const description of descriptions) {
  for (const projectId of [undefined, null, "p-web"]) {
    for (const taskId of [undefined, null, "t"]) {
      const fields = { description, projectId, taskId };
      add("autopilot", "filingKeyOf", { fields }, filingKeyOf(fields));
      add("autopilot", "isFileable", { fields }, isFileable(fields));
    }
  }
}
add("autopilot", "filingKeyOf", { fields: {} }, filingKeyOf({}));
add("autopilot", "isFileable", { fields: {} }, isFileable({}));

const APPS = ["com.figma.desktop", "com.microsoft.vscode", "com.google.chrome", "com.tinyspeck.slackmacgap", "\u{1F600}.app"];
const FILINGS = [
  { description: "Website redesign", projectId: "p-web", taskId: null },
  { description: "API work", projectId: "p-api", taskId: null },
  { description: "Research", projectId: null, taskId: null },
  { description: "", projectId: null, taskId: null },
];

const desktopSegments = (count: number, now: number, spanMin: number): ActivitySegment[] => {
  // Built backwards from a little before now, so most cases are "live" and
  // reach a start, a switch or a stop rather than the absence check.
  const out: ActivitySegment[] = [];
  let cursor = now - (chance(0.85) ? int(0, 120) * 1000 : int(4, 30) * MIN);
  const floor = now - spanMin * MIN;
  for (let i = 0; i < count && cursor > floor; i += 1) {
    const length = int(1, 20) * (chance(0.5) ? 30_000 : MIN);
    const end = cursor + (chance(0.1) ? MIN : 0);
    const start = Math.max(floor, cursor - length);
    out.push({ source: "desktop", start, end, key: pick(APPS), afk: chance(0.05) });
    cursor = start - (chance(0.15) ? int(1, 25) * MIN : chance(0.3) ? int(0, 3) * 10_000 : 0);
  }
  return out.reverse();
};

const randomEntries = (count: number, now: number): LearnableEntry[] =>
  Array.from({ length: count }, () => {
    const start = now - int(10, 300) * MIN;
    const filing = pick(FILINGS);
    return {
      start,
      end: start + (chance(0.05) ? 0 : int(5, 90) * MIN),
      ...filing,
      tagIds: pick([[], ["t-1"], ["a", "b"]]),
      billable: chance(0.5),
    };
  });

const entriesOf = (map: Map<string, AutopilotFiling>): [string, AutopilotFiling][] =>
  [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

for (let i = 0; i < 40; i += 1) {
  const now = T0 + 6 * 60 * MIN;
  const segments = desktopSegments(int(5, 40), now, 300);
  const entries = randomEntries(int(0, 12), now);
  const options = chance(0.3) ? { minEvidenceMs: pick([0, 5 * MIN, 30 * MIN]), minShare: pick([0, 0.5, 0.9]) } : undefined;
  add("autopilot", "learnFilings", { segments, entries, options }, entriesOf(learnFilings(segments, entries, options)));
}

const autopilotRules = (): ActivityRule[] => {
  const rules: ActivityRule[] = [];
  if (chance(0.8)) rules.push({ id: "r-figma", pattern: "com.figma.desktop", description: "Website redesign", projectId: "p-web" });
  if (chance(0.7)) rules.push({ id: "r-code", pattern: "com.microsoft.vscode", description: "API work", projectId: "p-api" });
  if (chance(0.3)) rules.push({ id: "r-slack", pattern: "com.tinyspeck.*", tagIds: ["t"] });
  if (chance(0.2)) rules.push({ id: "r-emoji", pattern: "\u{1F600}*", description: "Emoji", taskId: "t-e" });
  return rules;
};
const learnedFor = (): [string, AutopilotFiling][] =>
  chance(0.5)
    ? [["com.google.chrome", { key: filingKeyOf(FILINGS[2]!), via: "learned", fields: { ...FILINGS[2]!, tagIds: [], billable: false } }]]
    : [];

for (let i = 0; i < 20; i += 1) {
  const rules = autopilotRules();
  const learned = learnedFor();
  const resolve = createFilingResolver(rules, new Map(learned));
  const apps = [...APPS, "unknown.app"];
  add("autopilot", "createFilingResolver", { rules, learned, apps }, apps.map((app) => resolve(app)));
}

const labelled = (now: number, count: number): LabelledPiece[] => {
  const keys = [filingKeyOf(FILINGS[0]!), filingKeyOf(FILINGS[1]!), null];
  const out: LabelledPiece[] = [];
  let cursor = now - int(30, 200) * MIN;
  for (let i = 0; i < count && cursor < now; i += 1) {
    if (chance(0.2)) cursor += int(1, 15) * MIN;
    const start = cursor;
    const end = Math.min(now, start + int(1, 15) * (chance(0.5) ? 20_000 : MIN));
    out.push({ start, end, app: pick(APPS), filing: pick(keys) });
    cursor = end;
  }
  return out;
};
for (let i = 0; i < 60; i += 1) {
  const now = T0 + 5 * 60 * MIN + int(0, 59) * 1000;
  const pieces = labelled(now, int(1, 25));
  const from = now - pick([30, 60, 240]) * MIN;
  const options = {
    bucketMs: pick([MIN, 30_000]),
    maxInterruptMs: pick([5, 10]) * MIN,
    absorbOtherMs: pick([3, 5]) * MIN,
  };
  add("autopilot", "trailingRun", { pieces, from, now, options }, trailingRun(pieces, from, now, options));
  const maxInterruptMs = pick([5, 10]) * MIN;
  add("autopilot", "trailingStreak", { pieces, from, now, maxInterruptMs }, trailingStreak(pieces, from, now, maxInterruptMs));
}

for (let i = 0; i < 400; i += 1) {
  const now = T0 + 5 * 60 * MIN;
  const segments = desktopSegments(int(1, 30), now, pick([10, 30, 90, 240]));
  const tracked = chance(0.4)
    ? Array.from({ length: int(1, 3) }, () => {
        const start = now - int(0, 120) * MIN;
        return { start, end: start + int(1, 60) * MIN };
      })
    : [];
  const rules = autopilotRules();
  const learned = learnedFor();
  const runningStart = now - int(1, 120) * MIN;
  const running: AutopilotRunning | null = chance(0.4)
    ? {
        start: runningStart,
        filingKey: filingKeyOf(pick(FILINGS.slice(0, 2))),
        owned: chance(0.8),
      }
    : null;
  const held = chance(0.2) ? [pick([filingKeyOf(FILINGS[0]!), filingKeyOf(FILINGS[1]!), "app:com.google.chrome", "app:com.figma.desktop"])] : [];
  const options = chance(0.3) ? { startAfterMs: pick([3, 5, 10, 15]) * MIN } : undefined;
  const decision = decideAutopilot({
    now,
    segments,
    tracked,
    running,
    resolve: createFilingResolver(rules, new Map(learned)),
    held: new Set(held),
    ...(options !== undefined ? { options } : {}),
  });
  add("autopilot", "decideAutopilot", { now, segments, tracked, running, rules, learned, held, options }, decision);
}

for (let i = 0; i < 40; i += 1) {
  const now = T0 + 3 * 60 * MIN;
  const segments = desktopSegments(int(0, 20), now, 180);
  const since = now - int(0, 180) * MIN;
  const breakMs = pick([5, 10, 20]) * MIN;
  add("autopilot", "lastBreakEnd", { segments, since, now, breakMs }, lastBreakEnd(segments, since, now, breakMs));
  add("autopilot", "hadBreakSince", { segments, since, now, breakMs }, hadBreakSince(segments, since, now, breakMs));
}
add("autopilot", "defaults", {}, DEFAULT_AUTOPILOT_OPTIONS);

// ── write ─────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
for (const [name, cases] of Object.entries(files)) {
  // One case per line: small, and a change reads as a diff of cases.
  writeFileSync(path.join(outDir, `core-${name}.json`), `[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`);
}
