/**
 * Tests for the tracker's day grouping — the pure helper behind the
 * day-grouped entry list on /track.
 */
import { describe, expect, it } from "vitest";
import type { DetailedEntry } from "@starter/shared";
import { dayHeadingLabel, groupEntriesByDay } from "./grouping";

/** Local wall-clock time as the ISO string the wire carries. */
const localIso = (
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0
): string => new Date(year, month, day, hours, minutes, 0, 0).toISOString();

let seq = 0;

const entry = (overrides: Partial<DetailedEntry> = {}): DetailedEntry => {
  seq += 1;
  const start = overrides.start ?? localIso(2026, 7, 21, 9, 0);
  return {
    id: `e${seq}`,
    workspaceId: "w1",
    authorId: "u1",
    description: "Wrote tests",
    projectId: "p1",
    taskId: null,
    billable: true,
    start,
    end: localIso(2026, 7, 21, 10, 0),
    durationSec: 3600,
    hourlyRate: 60,
    currency: "EUR",
    source: "web",
    timeZone: null,
    runaway: null,
    tagIds: [],
    invoiceId: null,
    importId: null,
    createdAt: start,
    updatedAt: start,
    projectName: "trackyourtime",
    projectColor: "#4f46e5",
    clientName: null,
    taskName: null,
    amount: 60,
    ...overrides,
  };
};

describe("groupEntriesByDay", () => {
  it("returns nothing for an empty list", () => {
    expect(groupEntriesByDay([])).toEqual([]);
  });

  it("buckets entries by their local calendar day", () => {
    const days = groupEntriesByDay([
      entry({ start: localIso(2026, 7, 21, 14, 0) }),
      entry({ start: localIso(2026, 7, 21, 9, 0) }),
      entry({ start: localIso(2026, 7, 20, 9, 0) }),
    ]);

    expect(days.map((day) => day.date)).toEqual(["2026-08-21", "2026-08-20"]);
    expect(days[0].entryCount).toBe(2);
    expect(days[1].entryCount).toBe(1);
  });

  it("buckets a late-night entry on the day it started", () => {
    const days = groupEntriesByDay([
      entry({
        start: localIso(2026, 7, 21, 23, 30),
        end: localIso(2026, 7, 22, 0, 30),
      }),
    ]);
    expect(days.map((day) => day.date)).toEqual(["2026-08-21"]);
  });

  it("keeps every entry as its own row, including look-alikes", () => {
    // Consecutive look-alikes used to collapse into an expandable cluster.
    // They no longer do: a row hidden behind a disclosure is a row the user
    // cannot see, edit or delete without first finding it.
    const days = groupEntriesByDay([
      entry({ description: "Wrote tests", projectId: "p1", durationSec: 600 }),
      entry({ description: "Wrote tests", projectId: "p1", durationSec: 900 }),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0].entries).toHaveLength(2);
    expect(days[0].entryCount).toBe(2);
    expect(days[0].totalSec).toBe(1500);
  });

  it("preserves the order it was given", () => {
    const days = groupEntriesByDay([
      entry({ description: "Wrote tests" }),
      entry({ description: "Stood up" }),
      entry({ description: "Wrote tests" }),
    ]);

    expect(days[0].entries.map((e) => e.description)).toEqual([
      "Wrote tests",
      "Stood up",
      "Wrote tests",
    ]);
  });

  it("splits look-alikes across a day boundary into their own days", () => {
    const days = groupEntriesByDay([
      entry({ description: "Wrote tests", start: localIso(2026, 7, 21, 9, 0) }),
      entry({ description: "Wrote tests", start: localIso(2026, 7, 20, 9, 0) }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0].entries).toHaveLength(1);
    expect(days[1].entries).toHaveLength(1);
  });

  it("keeps a running entry as its own row", () => {
    const days = groupEntriesByDay([
      entry({ description: "Wrote tests", end: null, durationSec: 0 }),
      entry({ description: "Wrote tests", durationSec: 600 }),
    ]);

    expect(days[0].entries).toHaveLength(2);
    expect(days[0].entries[0].end).toBeNull();
    // A running entry contributes no finished seconds to the day total.
    expect(days[0].totalSec).toBe(600);
  });

  it("totals finished seconds, billable seconds and money per day", () => {
    const days = groupEntriesByDay([
      entry({ durationSec: 3600, billable: true, amount: 60 }),
      entry({
        description: "Admin",
        durationSec: 1800,
        billable: false,
        amount: 0,
        hourlyRate: null,
      }),
      entry({ description: "Running", end: null, durationSec: 0, amount: 0 }),
    ]);

    expect(days[0].totalSec).toBe(5400);
    expect(days[0].billableSec).toBe(3600);
    expect(days[0].entryCount).toBe(3);
    expect(days[0].amount).toBe(60);
  });

  it("sums the day's money without float drift", () => {
    const days = groupEntriesByDay([
      entry({ description: "a", amount: 0.1 }),
      entry({ description: "a", amount: 0.2 }),
    ]);
    expect(days[0].amount).toBe(0.3);
  });
});

describe("dayHeadingLabel", () => {
  const now = new Date(2026, 7, 21, 12, 0, 0);

  it("names today and yesterday", () => {
    expect(dayHeadingLabel("2026-08-21", now)).toBe("Today");
    expect(dayHeadingLabel("2026-08-20", now)).toBe("Yesterday");
  });

  it("handles yesterday across a month boundary", () => {
    expect(dayHeadingLabel("2026-07-31", new Date(2026, 7, 1, 12, 0))).toBe(
      "Yesterday"
    );
  });

  it("falls back to a formatted date for older days", () => {
    const label = dayHeadingLabel("2026-08-14", now);
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label).toContain("14");
  });

  it("shows the year only for another year", () => {
    expect(dayHeadingLabel("2025-08-14", now)).toContain("2025");
    expect(dayHeadingLabel("2026-08-14", now)).not.toContain("2026");
  });

  it("returns the key unchanged when it cannot be parsed", () => {
    expect(dayHeadingLabel("not-a-day", now)).toBe("not-a-day");
  });
});
