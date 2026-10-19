// Synthetic-only profiler for `entries.list` (tracker, calendar, REST
// /entries). Requires an explicitly supplied loopback Mongo URI; creates a
// disposable database, never reads existing application records, and drops
// the database when it is done.
//
// Usage (from packages/server):
//   node --import tsx src/scripts/profile-entry-list.ts mongodb://127.0.0.1:<port>/
//
// Each case lists a range page by page, following `nextCursor` to the end, and
// reports the keys and documents the time entries collection examined for it
// (the database profiler, summed over every query the case sent), the pages
// and rows it returned, a digest of those rows, and the median wall time of
// five runs. Ids are deterministic, so two builds' digests compare directly.
// PROFILE_OPS=1 also prints every profiled query with its plan summary.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { TimeEntry } from "../models/TimeEntry.js";
import { listEntries } from "../services/entries/list.js";

const ENTRY_COUNT = 100_000;
const WORKSPACE = "fixture";
const OWNER = "fixture-owner";
const COLLEAGUE = "fixture-colleague";

const uri = process.argv[2] ?? "";
const url = new URL(uri);
assert.equal(url.protocol, "mongodb:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback MongoDB only");
assert.ok(!url.username && !url.password && !url.search && url.pathname === "/", "supply only a local host and port");

type Case = { label: string; ownOnly: boolean; from: string; to: string; pages?: number };

/** The newest week, a month in the middle of the history, and all of it. */
const CASES: Case[] = [
  { label: "week", ownOnly: false, from: "2026-09-28T00:00:00Z", to: "2026-10-05T00:00:00Z" },
  { label: "week, own entries only", ownOnly: true, from: "2026-09-28T00:00:00Z", to: "2026-10-05T00:00:00Z" },
  { label: "week a year ago", ownOnly: false, from: "2025-09-29T00:00:00Z", to: "2025-10-06T00:00:00Z" },
  { label: "week three years ago", ownOnly: false, from: "2023-10-02T00:00:00Z", to: "2023-10-09T00:00:00Z" },
  { label: "June 2017", ownOnly: false, from: "2017-06-01T00:00:00Z", to: "2017-07-01T00:00:00Z" },
  { label: "all time, first page", ownOnly: false, from: "2000-01-01T00:00:00Z", to: "2999-12-31T00:00:00Z", pages: 1 },
  { label: "all time, 20 pages", ownOnly: false, from: "2000-01-01T00:00:00Z", to: "2999-12-31T00:00:00Z", pages: 20 },
];

const scopeFor = (ownOnly: boolean) => ({
  workspaceId: WORKSPACE,
  userId: OWNER,
  visibility: { userId: OWNER, canViewOthersTime: !ownOnly, canViewOthersMoney: true },
});

/** Every page of one case, in order. */
const listAll = async (which: Case): Promise<{ pages: number; rows: unknown[] }> => {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listEntries(scopeFor(which.ownOnly), {
      from: which.from,
      to: which.to,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    pages += 1;
    rows.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor && (which.pages === undefined || pages < which.pages));
  return { pages, rows };
};

const dbName = `trackyourtime-profile-${randomUUID()}`;
await mongoose.connect(uri, { dbName, autoIndex: false });
try {
  const db = mongoose.connection.db!;
  const entries = db.collection(TimeEntry.collection.name);
  const newest = Date.parse("2026-10-01T18:00:00Z");
  for (let offset = 0; offset < ENTRY_COUNT; offset += 1000) {
    await entries.insertMany(Array.from({ length: Math.min(1000, ENTRY_COUNT - offset) }, (_, i) => {
      const n = offset + i;
      // Sixteen 25-minute entries per day, newest first, back to ~2009.
      const start = new Date(newest - Math.floor(n / 16) * 86_400_000 - (n % 16) * 1_800_000);
      return {
        _id: new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0")),
        workspaceId: WORKSPACE,
        authorId: n % 4 === 0 ? COLLEAGUE : OWNER,
        start,
        end: new Date(start.getTime() + 1_500_000),
        durationSec: 1500,
        description: `Synthetic work item ${n}`,
        projectId: null,
        taskId: null,
        billable: true,
        hourlyRate: 95,
        currency: "EUR",
        source: "web",
        tagIds: [],
        createdAt: start,
        updatedAt: start,
      };
    }));
  }
  for (const [keys, options] of TimeEntry.schema.indexes()) {
    await entries.createIndex(keys as Record<string, 1 | -1>, options as Record<string, unknown>);
  }

  for (const which of CASES) {
    // Two warm-up runs, so the measured one reads cached plans rather than
    // paying for the planner's trial of every candidate index.
    await listAll(which);
    await listAll(which);

    await db.command({ profile: 0 });
    await db.collection("system.profile").drop().catch(() => undefined);
    await db.command({ profile: 2 });
    const { pages, rows } = await listAll(which);
    await db.command({ profile: 0 });
    const ops = await db
      .collection("system.profile")
      .find({ ns: `${dbName}.${TimeEntry.collection.name}` })
      .toArray();
    if (process.env.PROFILE_OPS) {
      for (const op of ops) {
        console.log(JSON.stringify({ op: op.op, keys: op.keysExamined, docs: op.docsExamined, plan: op.planSummary, cmd: Object.keys(op.command ?? {})[0] }));
      }
    }
    const keysExamined = ops.reduce((sum, op) => sum + Number(op.keysExamined ?? 0), 0);
    const docsExamined = ops.reduce((sum, op) => sum + Number(op.docsExamined ?? 0), 0);

    const timings: number[] = [];
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const began = performance.now();
      await listAll(which);
      timings.push(performance.now() - began);
    }
    timings.sort((a, b) => a - b);
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
    console.log(JSON.stringify({
      case: which.label,
      pages,
      rows: rows.length,
      queries: ops.length,
      keysExamined,
      docsExamined,
      medianMs: Number(timings[2]!.toFixed(1)),
      digest,
    }));
  }
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
