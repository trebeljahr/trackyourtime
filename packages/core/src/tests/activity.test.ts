import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSuggestions,
  hostMatches,
  matchRule,
  mergeSegments,
  normalizeHostPattern,
  subtractIntervals,
  unionIntervals,
  type ActivityRule,
  type ActivitySegment,
} from "../activity/index.js";

const MIN = 60_000;
const T0 = Date.parse("2026-09-14T09:00:00.000Z");

const seg = (
  key: string,
  startMin: number,
  endMin: number,
  extra: Partial<ActivitySegment> = {},
): ActivitySegment => ({
  source: "browser",
  start: T0 + startMin * MIN,
  end: T0 + endMin * MIN,
  key,
  afk: false,
  ...extra,
});

const span = (startMin: number, endMin: number): { start: number; end: number } => ({
  start: T0 + startMin * MIN,
  end: T0 + endMin * MIN,
});

// ── mergeSegments ────────────────────────────────────────────────────

test("same-key segments inside the pulse gap merge into one", () => {
  const merged = mergeSegments([
    seg("a.test", 0, 5),
    { ...seg("a.test", 5, 10), start: T0 + 5 * MIN + 30_000 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.start, T0);
  assert.equal(merged[0]?.end, T0 + 10 * MIN);
});

test("a gap longer than the pulse keeps segments apart", () => {
  const merged = mergeSegments([seg("a.test", 0, 5), seg("a.test", 7, 10)]);
  assert.equal(merged.length, 2);
});

test("the pulse gap is configurable", () => {
  const merged = mergeSegments([seg("a.test", 0, 5), seg("a.test", 7, 10)], {
    pulseGapMs: 3 * MIN,
  });
  assert.equal(merged.length, 1);
});

test("different keys, sources or afk flags never merge", () => {
  const merged = mergeSegments([
    seg("a.test", 0, 5),
    seg("b.test", 5, 10),
    seg("a.test", 10, 15, { source: "desktop" }),
    seg("a.test", 15, 20, { afk: true }),
  ]);
  assert.equal(merged.length, 4);
});

test("an interleaved glance does not split the stretch it interrupted", () => {
  const merged = mergeSegments([
    seg("a.test", 0, 5),
    { ...seg("b.test", 5, 5), end: T0 + 5 * MIN + 20_000 },
    { ...seg("a.test", 5, 9), start: T0 + 5 * MIN + 20_000 },
  ]);
  assert.deepEqual(
    merged.map((s) => [s.key, (s.start - T0) / 1000, (s.end - T0) / 1000]),
    [
      ["a.test", 0, 540],
      ["b.test", 300, 320],
    ],
  );
});

test("merging keeps the first label and drops empty segments", () => {
  const merged = mergeSegments([
    seg("a.test", 0, 5, { label: "First" }),
    seg("a.test", 5, 10, { label: "Second" }),
    seg("a.test", 20, 20),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.label, "First");
});

test("merging does not mutate its input", () => {
  const input = [seg("a.test", 0, 5), seg("a.test", 5, 10)];
  const copy = structuredClone(input);
  mergeSegments(input);
  assert.deepEqual(input, copy);
});

// ── interval arithmetic ─────────────────────────────────────────────

test("union joins overlapping and touching intervals", () => {
  assert.deepEqual(unionIntervals([span(10, 20), span(0, 5), span(5, 12)]), [span(0, 20)]);
});

test("subtract leaves the pieces outside the holes", () => {
  assert.deepEqual(subtractIntervals(span(0, 60), [span(10, 20), span(50, 70)]), [
    span(0, 10),
    span(20, 50),
  ]);
  assert.deepEqual(subtractIntervals(span(0, 60), [span(-10, 70)]), []);
});

// ── buildSuggestions ─────────────────────────────────────────────────

test("thirty minutes of tab switching becomes one suggestion", () => {
  const segments: ActivitySegment[] = [];
  for (let minute = 0; minute < 30; minute += 3) {
    segments.push(seg(minute % 2 === 0 ? "docs.test" : "code.test", minute, minute + 3));
  }
  const suggestions = buildSuggestions(segments, [], []);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.start, T0);
  assert.equal(suggestions[0]?.end, T0 + 30 * MIN);
  const shares = suggestions[0]?.topKeys.reduce((sum, key) => sum + key.share, 0) ?? 0;
  assert.ok(Math.abs(shares - 1) < 1e-9);
  assert.deepEqual(suggestions[0]?.proposed, {});
});

test("already tracked time is subtracted and splits the block", () => {
  const suggestions = buildSuggestions([seg("docs.test", 0, 60)], [span(20, 30)], []);
  assert.deepEqual(
    suggestions.map((s) => [(s.start - T0) / MIN, (s.end - T0) / MIN]),
    [
      [0, 20],
      [30, 60],
    ],
  );
});

test("a tracked interval splits a block even when the gap is under the threshold", () => {
  const suggestions = buildSuggestions(
    [seg("docs.test", 0, 10), seg("docs.test", 12, 22)],
    [span(10, 12)],
    [],
  );
  assert.equal(suggestions.length, 2);
});

test("fully tracked activity yields nothing", () => {
  assert.deepEqual(buildSuggestions([seg("docs.test", 0, 60)], [span(-5, 65)], []), []);
});

test("afk segments are never suggested", () => {
  assert.deepEqual(buildSuggestions([seg("docs.test", 0, 60, { afk: true })], [], []), []);
});

test("a gap over gapMinutes splits blocks; under it joins them", () => {
  const segments = [seg("a.test", 0, 10), seg("a.test", 20, 30), seg("a.test", 41, 50)];
  const blocks = buildSuggestions(segments, [], []);
  // 10 → 20 is exactly the threshold and joins; 30 → 41 exceeds it.
  assert.deepEqual(
    blocks.map((s) => [(s.start - T0) / MIN, (s.end - T0) / MIN]),
    [
      [0, 30],
      [41, 50],
    ],
  );
  assert.equal(buildSuggestions(segments, [], [], { gapMinutes: 5 }).length, 3);
});

test("blocks with less covered time than minMinutes are dropped", () => {
  // Two 2-minute glances 8 minutes apart: a 12-minute span, 4 minutes of activity.
  const segments = [seg("a.test", 0, 2), seg("a.test", 10, 12)];
  assert.deepEqual(buildSuggestions(segments, [], []), []);
  assert.equal(buildSuggestions(segments, [], [], { minMinutes: 4 }).length, 1);
  assert.equal(buildSuggestions([seg("a.test", 0, 5)], [], []).length, 1);
});

test("top keys are ranked by time, ties by key, and capped", () => {
  const [suggestion] = buildSuggestions(
    [
      seg("b.test", 0, 10),
      seg("a.test", 10, 20),
      seg("c.test", 20, 40),
      seg("d.test", 40, 41),
    ],
    [],
    [],
    { maxKeys: 3 },
  );
  assert.deepEqual(
    suggestion?.topKeys.map((k) => [k.key, k.seconds]),
    [
      ["c.test", 1200],
      ["a.test", 600],
      ["b.test", 600],
    ],
  );
  assert.ok(Math.abs((suggestion?.topKeys[0]?.share ?? 0) - 20 / 41) < 1e-9);
});

test("the first matching rule for the dominant key fills the proposal", () => {
  const rules: ActivityRule[] = [
    { id: "chat", pattern: "chat.test", projectId: "p-chat" },
    { id: "code", pattern: "*.code.test", projectId: "p-code", taskId: "t1", tagIds: ["g"], billable: true, description: "Dev" },
    { id: "code-late", pattern: "code.test", projectId: "p-other" },
  ];
  const [suggestion] = buildSuggestions(
    [seg("chat.test", 0, 5), seg("code.test", 5, 30)],
    [],
    rules,
  );
  assert.equal(suggestion?.ruleId, "code");
  assert.deepEqual(suggestion?.proposed, {
    description: "Dev",
    projectId: "p-code",
    taskId: "t1",
    tagIds: ["g"],
    billable: true,
  });
});

test("the output is deterministic regardless of input order", () => {
  const segments = [seg("a.test", 0, 10), seg("b.test", 10, 20), seg("a.test", 40, 55)];
  const tracked = [span(15, 17)];
  const forward = buildSuggestions(segments, tracked, []);
  const backward = buildSuggestions([...segments].reverse(), tracked, []);
  assert.deepEqual(forward, backward);
});

test("instants across a DST change keep their real length", () => {
  // Europe's 2026 spring-forward is 01:00Z on 29 March: local 02:00 becomes
  // 03:00. Written with offsets, this is 01:30+01:00 → 03:30+02:00, which is
  // one hour of real time even though the wall clock moved two.
  const start = Date.parse("2026-03-29T01:30:00+01:00");
  const end = Date.parse("2026-03-29T03:30:00+02:00");
  const [suggestion] = buildSuggestions(
    [{ source: "browser", start, end, key: "a.test", afk: false }],
    [],
    [],
  );
  assert.equal(suggestion?.end - (suggestion?.start ?? 0), 60 * MIN);
  assert.equal(suggestion?.topKeys[0]?.seconds, 3600);

  // And the autumn change (01:00Z on 25 October) repeats a wall hour: the
  // tracked entry written in the second 02:30 subtracts only real overlap.
  const autumnStart = Date.parse("2026-10-25T02:00:00+02:00");
  const autumnEnd = Date.parse("2026-10-25T03:00:00+01:00");
  const tracked = {
    start: Date.parse("2026-10-25T02:30:00+01:00"),
    end: Date.parse("2026-10-25T02:40:00+01:00"),
  };
  const pieces = buildSuggestions(
    [{ source: "browser", start: autumnStart, end: autumnEnd, key: "a.test", afk: false }],
    [tracked],
    [],
  );
  assert.equal(autumnEnd - autumnStart, 120 * MIN);
  assert.deepEqual(
    pieces.map((p) => (p.end - p.start) / MIN),
    [90, 20],
  );
});

// ── rules ────────────────────────────────────────────────────────────

test("host globs", () => {
  assert.equal(hostMatches("example.com", "example.com"), true);
  assert.equal(hostMatches("example.com", "docs.example.com"), false);
  assert.equal(hostMatches("*.example.com", "docs.example.com"), true);
  assert.equal(hostMatches("*.example.com", "example.com"), true);
  assert.equal(hostMatches("*.example.com", "badexample.com"), false);
  assert.equal(hostMatches("docs.*", "docs.example.com"), true);
  assert.equal(hostMatches("EXAMPLE.com", "example.COM"), true);
  assert.equal(hostMatches("exa?ple.com", "example.com"), false);
  assert.equal(hostMatches("", "example.com"), false);
});

test("patterns tolerate pasted URLs and ports", () => {
  assert.equal(normalizeHostPattern(" https://Docs.Example.com:8080/a/b "), "docs.example.com");
  assert.equal(hostMatches("https://example.com/path", "example.com"), true);
});

test("matchRule tries keys by time, then rules in order", () => {
  const rules: ActivityRule[] = [
    { id: "1", pattern: "b.test" },
    { id: "2", pattern: "a.test" },
    { id: "3", pattern: "*.test" },
  ];
  assert.equal(matchRule(rules, ["a.test", "b.test"])?.id, "2");
  assert.equal(matchRule(rules, ["z.test"])?.id, "3");
  assert.equal(matchRule(rules, ["z.other"]), null);
});
