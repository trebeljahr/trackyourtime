// The lower bound every report's range scan gets from
// `earliestOverlappingStart`. Its promise: it never excludes an entry that
// overlaps the range. Entries have no maximum length (the runaway guard can be
// off, `ask` keeps a timer running, manual and imported entries are uncapped),
// so the fixture is full of the cases a `from - maxLength` shortcut would get
// wrong: timers running for years, entries spanning months, an entry ending
// exactly at `from`, a legacy row with no `end` field at all.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Types } from "mongoose";
import { earliestOverlappingStart } from "../trpc/routers/reports.js";
import { TimeEntry } from "../models/TimeEntry.js";
import {
  matchesFilter,
  memoryCollection,
  stubModel,
  type Row,
} from "./support/in-memory-models.js";

const WORKSPACE = "ws_bound";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const entries = memoryCollection();
after(stubModel(TimeEntry, entries));

const row = (start: number, end: number | null | undefined, workspaceId = WORKSPACE): Row => {
  const doc: Row = { _id: new Types.ObjectId(), workspaceId, start: new Date(start) };
  if (end !== undefined) doc.end = end === null ? null : new Date(end);
  return doc;
};

/** The overlap every report matches, without any bound. */
const overlaps = (from: Date, to: Date): Row => ({
  $and: [
    { workspaceId: WORKSPACE },
    { start: { $lt: to } },
    { $or: [{ end: null }, { end: { $gt: from } }] },
  ],
});

const FROM = Date.parse("2026-09-28T00:00:00.000Z");

describe("earliestOverlappingStart", () => {
  it("is `from` itself when nothing is open at `from`", async () => {
    entries.rows = [
      row(FROM - 2 * HOUR, FROM - HOUR),
      // Ends exactly at `from`: it does not overlap a range starting there.
      row(FROM - HOUR, FROM),
      row(FROM + HOUR, FROM + 2 * HOUR),
    ];
    assert.deepEqual(await earliestOverlappingStart(WORKSPACE, new Date(FROM)), new Date(FROM));
  });

  it("reaches back to a timer that has been running for years", async () => {
    const started = FROM - 3 * 365 * DAY;
    entries.rows = [row(FROM - HOUR, FROM + HOUR), row(started, null)];
    assert.deepEqual(await earliestOverlappingStart(WORKSPACE, new Date(FROM)), new Date(started));
  });

  it("reaches back to a closed entry longer than any cap, and to a row with no `end`", async () => {
    const months = FROM - 90 * DAY;
    const legacy = FROM - 400 * DAY;
    entries.rows = [row(months, FROM + DAY), row(FROM - HOUR, FROM + HOUR)];
    assert.deepEqual(await earliestOverlappingStart(WORKSPACE, new Date(FROM)), new Date(months));
    entries.rows.push(row(legacy, undefined));
    assert.deepEqual(await earliestOverlappingStart(WORKSPACE, new Date(FROM)), new Date(legacy));
  });

  it("answers the same from the start index when many entries end after `from`", async () => {
    const months = FROM - 90 * DAY;
    entries.rows = [
      row(FROM + HOUR, FROM + 2 * HOUR),
      row(FROM + 3 * HOUR, FROM + 4 * HOUR),
      row(months, FROM + DAY),
      row(FROM - 200 * DAY, FROM - 199 * DAY),
    ];
    for (const limit of [1, 2, 3, 4, 5]) {
      assert.deepEqual(
        await earliestOverlappingStart(WORKSPACE, new Date(FROM), limit),
        new Date(months),
        `limit ${limit}`,
      );
    }
  });

  it("is null, not a guess, when the probe cannot be answered", async () => {
    entries.rows = [row(FROM - 10 * DAY, null)];
    const model = TimeEntry as unknown as { countDocuments: unknown };
    const countDocuments = model.countDocuments;
    model.countDocuments = () => Promise.reject(new Error("hint provided does not correspond to an existing index"));
    try {
      assert.equal(await earliestOverlappingStart(WORKSPACE, new Date(FROM)), null);
    } finally {
      model.countDocuments = countDocuments;
    }
  });

  it("ignores another workspace's entries", async () => {
    entries.rows = [row(FROM - 10 * DAY, null, "ws_other"), row(FROM - HOUR, FROM + HOUR)];
    assert.deepEqual(
      await earliestOverlappingStart(WORKSPACE, new Date(FROM)),
      new Date(FROM - HOUR),
    );
  });

  it("never drops an overlapping entry, over random histories and ranges", async () => {
    // A small deterministic generator, so a failure reproduces.
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const lengths = [0.25 * HOUR, 8 * HOUR, 30 * HOUR, 9 * DAY, 200 * DAY];
    const base = Date.parse("2025-01-01T00:00:00.000Z");
    for (let history = 0; history < 40; history += 1) {
      entries.rows = Array.from({ length: 60 }, () => {
        const start = base + Math.floor(random() * 600) * DAY + Math.floor(random() * 24) * HOUR;
        const kind = random();
        const workspaceId = random() < 0.1 ? "ws_other" : WORKSPACE;
        if (kind < 0.05) return row(start, null, workspaceId);
        if (kind < 0.08) return row(start, undefined, workspaceId);
        const length = lengths[Math.floor(random() * lengths.length)] ?? HOUR;
        return row(start, start + length, workspaceId);
      });
      for (let range = 0; range < 25; range += 1) {
        const from = new Date(base + Math.floor(random() * 650) * DAY);
        // Sometimes `from` is exactly where an entry ends.
        if (range % 5 === 0) {
          const ending = entries.rows.find((entry) => entry.end instanceof Date);
          if (ending) from.setTime((ending.end as Date).getTime());
        }
        const to = new Date(from.getTime() + (1 + Math.floor(random() * 40)) * DAY);
        const unbounded = entries.rows.filter((entry) => matchesFilter(entry, overlaps(from, to)));
        // The default limit answers from the end index; a limit of 1 or 3
        // sends most ranges to the oldest-first walk of the start index.
        for (const limit of [undefined, 1, 3]) {
          const bound = await earliestOverlappingStart(WORKSPACE, from, limit);
          assert.ok(bound, "the in-memory store answers every probe");
          const bounded = entries.rows.filter((entry) =>
            matchesFilter(entry, { $and: [overlaps(from, to), { start: { $gte: bound } }] }),
          );
          assert.deepEqual(
            bounded,
            unbounded,
            `history ${history}, range ${from.toISOString()}, limit ${limit ?? "default"}`,
          );
          // Exact, not merely safe: the bound is `from` or an overlapping start.
          assert.ok(
            bound.getTime() === from.getTime() ||
              unbounded.some((entry) => (entry.start as Date).getTime() === bound.getTime()),
          );
        }
      }
    }
  });
});
