import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTimerToggle, recentWindowStartMs, RECENT_TIMER_DAYS } from "../timer-toggle.js";

type Row = { id: string; start: string; end: string | null };

const now = new Date(2026, 8, 17, 15, 0, 0).getTime();
const daysAgo = (days: number, hour = 12): string => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const decide = (rows: Row[], running = false) =>
  decideTimerToggle({
    running,
    candidates: rows,
    startOf: (row) => row.start,
    isFinished: (row) => row.end !== null,
    nowMs: now,
  });

test("a running timer is stopped, whatever else there is", () => {
  assert.deepEqual(decide([{ id: "a", start: daysAgo(0), end: daysAgo(0, 13) }], true), { kind: "stop" });
});

test("the newest finished entry is continued, regardless of input order", () => {
  const rows: Row[] = [
    { id: "old", start: daysAgo(3), end: daysAgo(3, 13) },
    { id: "new", start: daysAgo(1), end: daysAgo(1, 13) },
  ];
  const decision = decide(rows);
  assert.equal(decision.kind, "continue");
  assert.equal(decision.kind === "continue" && decision.candidate.id, "new");
});

test("an unfinished row is never continued", () => {
  const decision = decide([
    { id: "open", start: daysAgo(0), end: null },
    { id: "done", start: daysAgo(2), end: daysAgo(2, 13) },
  ]);
  assert.equal(decision.kind === "continue" && decision.candidate.id, "done");
});

test("the window starts at local midnight RECENT_TIMER_DAYS days ago", () => {
  assert.equal(RECENT_TIMER_DAYS, 7);
  const since = new Date(recentWindowStartMs(now));
  assert.equal(since.getHours(), 0);
  assert.equal(decide([{ id: "edge", start: daysAgo(7, 0), end: daysAgo(7, 1) }]).kind, "continue");
  assert.deepEqual(decide([{ id: "stale", start: daysAgo(8, 23), end: daysAgo(8, 23) }]), { kind: "compose" });
});

test("nothing to resume asks for the composer; a bad date is skipped", () => {
  assert.deepEqual(decide([]), { kind: "compose" });
  assert.deepEqual(decide([{ id: "bad", start: "not a date", end: "x" }]), { kind: "compose" });
});
