import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose, { type PipelineStage } from "mongoose";
import { TimeEntry } from "../models/TimeEntry.js";
import { listEntries } from "../services/entries/list.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const input = { from: "2000-01-01", to: "2999-12-31", limit: 50 };
const scope = (ownOnly: boolean) => ({
  workspaceId: "fixture",
  userId: "author-1",
  visibility: { userId: "author-1", canViewOthersTime: !ownOnly, canViewOthersMoney: false },
});

function stages(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object.stage === "string" ? [object.stage] : []),
    ...Object.values(object).flatMap(stages),
  ];
}

describe("tracker ordered indexes", { skip: skipWithoutDatabase }, () => {
  let pipeline: PipelineStage[] = [];
  before(async () => {
    await connectTestDatabase("tracker-query-index");
    // Finish automatic builds before recreating the indexes of older installs.
    await TimeEntry.init();
    await TimeEntry.collection.dropIndexes();
    await TimeEntry.collection.createIndex({ workspaceId: 1, start: -1 });
    await TimeEntry.collection.createIndex({ workspaceId: 1, authorId: 1, start: -1 });
    const now = Date.parse("2026-10-03T00:00:00Z");
    await TimeEntry.collection.insertMany(Array.from({ length: 2000 }, (_, n) => {
      const start = new Date(now - Math.floor(n / 4) * 3600000);
      return {
        _id: new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0")),
        workspaceId: n % 5 === 0 ? "other" : "fixture",
        authorId: `author-${n % 2}`,
        description: "Synthetic work",
        projectId: null,
        taskId: null,
        billable: true,
        start,
        end: new Date(start.getTime() + 1800000),
        durationSec: 1800,
        hourlyRate: 100,
        currency: "EUR",
        source: "web",
        createdAt: start,
        updatedAt: start,
      };
    }));
    mongoose.set("debug", (collection: string, method: string, ...args: unknown[]) => {
      if (collection === TimeEntry.collection.name && method === "aggregate") {
        pipeline = args[0] as PipelineStage[];
      }
    });
  });
  after(async () => {
    mongoose.set("debug", false);
    await dropTestDatabase();
  });

  it("removes full-history sorts while preserving both visibility scopes and tied cursor pages", async () => {
    const baseline = new Map<boolean, Awaited<ReturnType<typeof listEntries>>[]>();
    for (const ownOnly of [false, true]) {
      const first = await listEntries(scope(ownOnly), input);
      const explain = await TimeEntry.aggregate(pipeline).explain("executionStats");
      const source = explain.stages[0].$cursor;
      assert.ok(stages(source.queryPlanner.winningPlan).includes("SORT"));
      assert.ok(source.executionStats.totalDocsExamined >= 800);
      assert.ok(first.nextCursor);
      const second = await listEntries(scope(ownOnly), { ...input, cursor: first.nextCursor });
      baseline.set(ownOnly, [first, second]);
    }
    // The real boot builder adds schema indexes without dropping old ones.
    await TimeEntry.createIndexes();
    const indexes = await TimeEntry.collection.listIndexes().toArray();
    assert.ok(indexes.some((index) => index.name === "workspaceId_1_start_-1"));
    for (const ownOnly of [false, true]) {
      let cursor: string | undefined;
      const ids = new Set<string>();
      for (const page of [0, 1]) {
        const result = await listEntries(scope(ownOnly), { ...input, ...(cursor ? { cursor } : {}) });
        assert.deepEqual(result, baseline.get(ownOnly)![page]);
        const explain = await TimeEntry.aggregate(pipeline).explain("executionStats");
        const source = explain.stages[0].$cursor;
        assert.ok(!stages(source.queryPlanner.winningPlan).includes("SORT"));
        assert.ok(source.executionStats.totalDocsExamined <= 110);
        for (const entry of result.entries) {
          assert.ok(!ids.has(entry.id), "cursor must not repeat tied entries");
          ids.add(entry.id);
          assert.equal(entry.workspaceId, "fixture");
          if (ownOnly) assert.equal(entry.authorId, "author-1");
          else if (entry.authorId !== "author-1") assert.equal(entry.hourlyRate, null);
        }
        cursor = result.nextCursor;
      }
      assert.equal(ids.size, 100);
    }
  });

  it("keeps entries that started before the requested window but overlap it", async () => {
    const start = new Date("2026-09-01T00:00:00Z");
    const docs = [null, new Date("2026-10-03T12:00:00Z")].map((end, n) => ({
      _id: new mongoose.Types.ObjectId(), workspaceId: "overlap", authorId: `author-${n}`,
      description: "Synthetic overlap", projectId: null, taskId: null, billable: false,
      start, end, durationSec: 0, currency: "EUR", source: "web", createdAt: start, updatedAt: start,
    }));
    await TimeEntry.collection.insertMany(docs);
    const result = await listEntries({ ...scope(false), workspaceId: "overlap" }, {
      from: "2026-10-03T00:00:00Z", to: "2026-10-04T00:00:00Z", limit: 50,
    });
    assert.deepEqual(new Set(result.entries.map((entry) => entry.id)), new Set(docs.map((doc) => String(doc._id))));
  });
});
