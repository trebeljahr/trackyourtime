import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appHoldKey,
  createFilingResolver,
  decideAutopilot,
  filingKeyOf,
  hadBreakSince,
  isFileable,
  lastBreakEnd,
  learnFilings,
  trailingRun,
  type ActivityRule,
  type ActivitySegment,
  type AutopilotFiling,
  type AutopilotInput,
  type LabelledPiece,
  type LearnableEntry,
} from "../activity/index.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-19T08:00:00.000Z");
const at = (min: number): number => T0 + min * MIN;

const seg = (key: string, startMin: number, endMin: number): ActivitySegment => ({
  source: "desktop",
  start: at(startMin),
  end: at(endMin),
  key,
  afk: false,
});

const entry = (startMin: number, endMin: number, fields: Partial<LearnableEntry> = {}): LearnableEntry => ({
  start: at(startMin),
  end: at(endMin),
  description: "Website redesign",
  projectId: "p-web",
  taskId: null,
  tagIds: [],
  billable: true,
  ...fields,
});

const FIGMA = "com.figma.desktop";
const SLACK = "com.tinyspeck.slackmacgap";
const CODE = "com.microsoft.vscode";
const CHROME = "com.google.chrome";

const RULES: ActivityRule[] = [
  { id: "r-figma", pattern: FIGMA, description: "Website redesign", projectId: "p-web" },
  { id: "r-code", pattern: CODE, description: "API work", projectId: "p-api" },
];

const resolver = (rules: ActivityRule[] = RULES, learned = new Map<string, AutopilotFiling>()) =>
  createFilingResolver(rules, learned);

const WEB = filingKeyOf({ description: "Website redesign", projectId: "p-web", taskId: null });
const API = filingKeyOf({ description: "API work", projectId: "p-api", taskId: null });

const decide = (input: Partial<AutopilotInput> & Pick<AutopilotInput, "now" | "segments">) =>
  decideAutopilot({ tracked: [], running: null, resolve: resolver(), held: new Set(), ...input });

// ── filing keys ──────────────────────────────────────────────────────

test("filing keys fold case and spacing, and ignore billable and tags", () => {
  assert.equal(
    filingKeyOf({ description: "  Website   Redesign ", projectId: "p-web", taskId: null }),
    filingKeyOf({ description: "website redesign", projectId: "p-web" }),
  );
  assert.notEqual(
    filingKeyOf({ description: "x", projectId: "p-a", taskId: null }),
    filingKeyOf({ description: "x", projectId: "p-b", taskId: null }),
  );
});

test("a filing needs a description or a project", () => {
  assert.equal(isFileable({}), false);
  assert.equal(isFileable({ description: "  " }), false);
  assert.equal(isFileable({ description: "x" }), true);
  assert.equal(isFileable({ projectId: "p" }), true);
});

// ── learning ─────────────────────────────────────────────────────────

test("an app used for one filing learns it", () => {
  const learned = learnFilings(
    [seg(FIGMA, 0, 30), seg(FIGMA, 60, 80)],
    [entry(0, 30), entry(60, 80, { tagIds: ["t-1"], billable: false })],
  );
  const figma = learned.get(FIGMA);
  assert.equal(figma?.key, WEB);
  assert.equal(figma?.via, "learned");
  // The newest entry of the filing decides tags and billable.
  assert.deepEqual(figma?.fields.tagIds, ["t-1"]);
  assert.equal(figma?.fields.billable, false);
});

test("an app split across filings learns nothing", () => {
  const learned = learnFilings(
    [seg(CHROME, 0, 30), seg(CHROME, 30, 60)],
    [entry(0, 30), entry(30, 60, { description: "Invoices", projectId: "p-admin" })],
  );
  assert.equal(learned.has(CHROME), false);
});

test("too little evidence learns nothing", () => {
  const learned = learnFilings([seg(FIGMA, 0, 10)], [entry(0, 10)]);
  assert.equal(learned.has(FIGMA), false);
});

test("nameless entries teach nothing", () => {
  const learned = learnFilings([seg(FIGMA, 0, 60)], [entry(0, 60, { description: "", projectId: null })]);
  assert.equal(learned.size, 0);
});

test("a rule wins over what was learned, and an empty rule files nothing", () => {
  const learned = new Map<string, AutopilotFiling>([
    [FIGMA, { key: API, via: "learned", fields: { description: "API work", projectId: "p-api" } }],
    [SLACK, { key: API, via: "learned", fields: { description: "API work", projectId: "p-api" } }],
  ]);
  const resolve = resolver([...RULES, { id: "r-slack", pattern: SLACK, tagIds: ["t"] }], learned);
  assert.equal(resolve(FIGMA)?.via, "rule");
  assert.equal(resolve(FIGMA)?.ruleId, "r-figma");
  assert.equal(resolve(SLACK), null);
  assert.equal(resolve(CHROME), null);
});

// ── runs ─────────────────────────────────────────────────────────────

const piece = (app: string, filing: string | null, startMin: number, endMin: number): LabelledPiece => ({
  app,
  filing,
  start: at(startMin),
  end: at(endMin),
});

const RUN_OPTIONS = { bucketMs: MIN, maxInterruptMs: 10 * MIN, absorbOtherMs: 5 * MIN };

test("a run follows its filing back through short interruptions", () => {
  const run = trailingRun(
    [piece(FIGMA, WEB, 0, 10), piece(SLACK, null, 10, 13), piece(CODE, API, 13, 15), piece(FIGMA, WEB, 15, 20)],
    at(-60),
    at(20),
    RUN_OPTIONS,
  );
  assert.equal(run?.filingKey, WEB);
  assert.equal(run?.start, at(0));
  assert.equal(run?.creditedMs, 15 * MIN);
  assert.equal(run?.appKey, FIGMA);
});

test("five minutes of another filing ends a run", () => {
  const run = trailingRun(
    [piece(FIGMA, WEB, 0, 10), piece(CODE, API, 10, 16), piece(FIGMA, WEB, 16, 20)],
    at(-60),
    at(20),
    RUN_OPTIONS,
  );
  assert.equal(run?.start, at(16));
  assert.equal(run?.creditedMs, 4 * MIN);
});

test("a long absence ends a run", () => {
  const run = trailingRun([piece(FIGMA, WEB, 0, 10), piece(FIGMA, WEB, 25, 30)], at(-60), at(30), RUN_OPTIONS);
  assert.equal(run?.start, at(25));
});

test("a run is not followed before `from`", () => {
  const run = trailingRun([piece(FIGMA, WEB, 0, 30)], at(12), at(30), RUN_OPTIONS);
  assert.equal(run?.start, at(12));
});

test("only unfiled activity is no run", () => {
  assert.equal(trailingRun([piece(CHROME, null, 0, 30)], at(-60), at(30), RUN_OPTIONS), null);
});

// ── starting ─────────────────────────────────────────────────────────

test("five minutes in a filed app start its timer, dated to the first minute", () => {
  const decision = decide({ now: at(6), segments: [seg(FIGMA, 0, 6)] });
  assert.equal(decision.kind, "start");
  if (decision.kind !== "start") return;
  assert.equal(decision.at, at(0));
  assert.equal(decision.filing.key, WEB);
  assert.equal(decision.filing.via, "rule");
  assert.equal(decision.appKey, FIGMA);
});

test("before the threshold it only watches", () => {
  const decision = decide({ now: at(3), segments: [seg(FIGMA, 0, 3)] });
  assert.equal(decision.kind, "none");
  if (decision.kind !== "none") return;
  assert.equal(decision.watch?.appKey, FIGMA);
  assert.equal(decision.watch?.filing?.key, WEB);
  assert.equal(decision.watch?.creditedMs, 3 * MIN);
});

test("the threshold is an option", () => {
  assert.equal(decide({ now: at(3), segments: [seg(FIGMA, 0, 3)], options: { startAfterMs: 3 * MIN } }).kind, "start");
});

test("an app it cannot file is never started, and is watched for the question", () => {
  const decision = decide({ now: at(30), segments: [seg(CHROME, 0, 30)] });
  assert.equal(decision.kind, "none");
  if (decision.kind !== "none") return;
  assert.equal(decision.watch?.appKey, CHROME);
  assert.equal(decision.watch?.filing, null);
  assert.equal(decision.watch?.since, at(0));
});

test("nobody here, nothing happens", () => {
  assert.deepEqual(decide({ now: at(20), segments: [seg(FIGMA, 0, 10)] }), { kind: "none", watch: null });
});

test("a start never reaches back across tracked time", () => {
  const decision = decide({ now: at(30), segments: [seg(FIGMA, 0, 30)], tracked: [{ start: at(5), end: at(20) }] });
  assert.equal(decision.kind, "start");
  if (decision.kind === "start") assert.equal(decision.at, at(20));
});

test("a held filing or app is not started", () => {
  assert.equal(decide({ now: at(10), segments: [seg(FIGMA, 0, 10)], held: new Set([WEB]) }).kind, "none");
  const byApp = decide({ now: at(10), segments: [seg(FIGMA, 0, 10)], held: new Set([appHoldKey(FIGMA)]) });
  assert.equal(byApp.kind, "none");
  if (byApp.kind === "none") assert.equal(byApp.watch?.held, true);
});

test("a timer it did not start is left alone", () => {
  const decision = decide({
    now: at(40),
    segments: [seg(FIGMA, 0, 10), seg(CODE, 10, 40)],
    running: { start: at(0), filingKey: WEB, owned: false },
  });
  assert.deepEqual(decision, { kind: "none", watch: null });
});

test("learned filings start too", () => {
  const learned = learnFilings([seg(CHROME, -300, -200)], [entry(-300, -200, { description: "Research" })]);
  const decision = decide({ now: at(6), segments: [seg(CHROME, 0, 6)], resolve: resolver([], learned) });
  assert.equal(decision.kind, "start");
  if (decision.kind === "start") {
    assert.equal(decision.filing.via, "learned");
    assert.equal(decision.filing.fields.description, "Research");
  }
});

// ── switching and stopping ───────────────────────────────────────────

test("ten minutes on another filing switch an Autopilot timer at its first minute", () => {
  const decision = decide({
    now: at(31),
    segments: [seg(FIGMA, 0, 20), seg(CODE, 20, 31)],
    running: { start: at(0), filingKey: WEB, owned: true },
  });
  assert.equal(decision.kind, "switch");
  if (decision.kind === "switch") {
    assert.equal(decision.at, at(20));
    assert.equal(decision.filing.key, API);
  }
});

test("a short visit to another filing does not switch", () => {
  const decision = decide({
    now: at(30),
    segments: [seg(FIGMA, 0, 20), seg(CODE, 20, 26), seg(FIGMA, 26, 30)],
    running: { start: at(0), filingKey: WEB, owned: true },
  });
  assert.equal(decision.kind, "none");
});

test("present but off the timer's work for twenty minutes stops it where the work ended", () => {
  const decision = decide({
    now: at(41),
    segments: [seg(FIGMA, 0, 20), seg(CHROME, 20, 41)],
    running: { start: at(0), filingKey: WEB, owned: true },
  });
  assert.deepEqual(decision, { kind: "stop", at: at(20) });
});

test("drift is counted from the end of a break, not across it", () => {
  // Figma until 20, away until 60, then Chrome: the idle guard owns 20–60.
  const early = decide({
    now: at(75),
    segments: [seg(FIGMA, 0, 20), seg(CHROME, 60, 75)],
    running: { start: at(0), filingKey: WEB, owned: true },
  });
  assert.equal(early.kind, "none");
  const later = decide({
    now: at(81),
    segments: [seg(FIGMA, 0, 20), seg(CHROME, 60, 81)],
    running: { start: at(0), filingKey: WEB, owned: true },
  });
  assert.deepEqual(later, { kind: "stop", at: at(60) });
});

test("a held filing is not switched to", () => {
  const decision = decide({
    now: at(31),
    segments: [seg(FIGMA, 0, 20), seg(CODE, 20, 31)],
    running: { start: at(0), filingKey: WEB, owned: true },
    held: new Set([API]),
  });
  assert.equal(decision.kind, "none");
});

// ── breaks ───────────────────────────────────────────────────────────

test("breaks are found between and after activity", () => {
  const segments = [seg(FIGMA, 0, 10), seg(FIGMA, 25, 30)];
  assert.equal(lastBreakEnd(segments, at(0), at(30), 10 * MIN), at(25));
  assert.equal(lastBreakEnd(segments, at(0), at(45), 10 * MIN), at(45));
  assert.equal(lastBreakEnd(segments, at(0), at(30), 20 * MIN), null);
  assert.equal(hadBreakSince(segments, at(0), at(30), 10 * MIN), true);
  assert.equal(hadBreakSince(segments, at(26), at(30), 10 * MIN), false);
});
