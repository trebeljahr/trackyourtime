// Synthetic-only profiler. Requires an explicitly supplied loopback Mongo URI;
// creates a disposable database and never reads existing application records.
// Usage: node --import tsx src/scripts/profile-tracker-queries.ts 100000 mongodb://127.0.0.1:59484/
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { TimeEntry } from "../models/TimeEntry.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { Client } from "../models/Client.js";
import { catalogEntryRollup } from "../services/catalog/rollup.js";
import { listEntries } from "../services/entries/list.js";

const uri = process.argv[3] ?? "";
const url = new URL(uri);
assert.equal(url.protocol, "mongodb:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback MongoDB only");
assert.ok(!url.username && !url.password && !url.search && url.pathname === "/", "supply only a local host and port");
const count = Number(process.argv[2] ?? 10000);
assert.ok([10000, 100000].includes(count), "fixture size must be 10000 or 100000");
const dbName = `trackyourtime-profile-${randomUUID()}`;
await mongoose.connect(uri, { dbName, autoIndex: false });
try {
  const db = mongoose.connection.db!;
  const entries = db.collection(TimeEntry.collection.name);
  const pingMs: number[] = [];
  for (let repeat = 0; repeat < 10; repeat++) {
    const began = performance.now();
    await db.command({ ping: 1 });
    pingMs.push(performance.now() - began);
  }
  pingMs.sort((a, b) => a - b);
  console.log(JSON.stringify({ count, label: "local-driver-ping", medianMs: Number(pingMs[5]!.toFixed(2)) }));
  const now = new Date("2026-10-03T00:00:00Z");
  const projectIds = Array.from({ length: 50 }, () => new mongoose.Types.ObjectId());
  const taskId = new mongoose.Types.ObjectId();
  const clientId = new mongoose.Types.ObjectId();
  await db.collection(Project.collection.name).insertMany(projectIds.map((_id, n) => ({ _id, workspaceId: "fixture", name: `Synthetic project ${n}`, color: "#000000", clientId: String(clientId), archived: false })));
  await db.collection(Project.collection.name).createIndex({ workspaceId: 1, archived: 1 });
  await db.collection(Task.collection.name).insertOne({ _id: taskId, workspaceId: "fixture", name: "Synthetic task" });
  await db.collection(Client.collection.name).insertOne({ _id: clientId, workspaceId: "fixture", name: "Synthetic client" });
  for (let offset = 0; offset < count; offset += 1000) {
    await entries.insertMany(Array.from({ length: Math.min(1000, count - offset) }, (_, i) => {
      const n = offset + i;
      // Sixteen half-hour entries/day/author; paired starts exercise cursor ties.
      const start = new Date(now.getTime() - Math.floor(n / 20) * 10800000);
      return { _id: new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0")), workspaceId: n % 5 === 0 ? "other" : "fixture", authorId: `author-${n % 10}`, start, end: n === 1 ? null : new Date(start.getTime() + 1800000), description: "Synthetic work", projectId: String(projectIds[Math.floor(n / 10) % projectIds.length]), taskId: String(taskId), billable: true, hourlyRate: 100, durationSec: 1800, currency: "EUR", source: "web", tagIds: [], createdAt: start, updatedAt: start };
    }));
  }
  // Preserve all declared indexes; compare only the two tie-breaker changes.
  const baseline = TimeEntry.schema.indexes().map(([keys, options]) => ({ key: Object.fromEntries(Object.entries(keys).filter(([key]) => key !== "_id").map(([key, direction]) => {
    assert.ok(direction === 1 || direction === -1, "profiler expects ordered indexes");
    return [key, direction] as const;
  })), ...(options.unique ? { unique: true } : {}), ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}) }));
  await entries.createIndexes(baseline);
  let pipeline: Record<string, unknown>[] = [];
  mongoose.set("debug", (collection: string, method: string, ...args: unknown[]) => {
    if (collection === TimeEntry.collection.name && method === "aggregate") pipeline = args[0] as Record<string, unknown>[];
  });
  const results = new Map<string, string>();
  for (const variant of ["baseline", "candidate"]) {
    if (variant === "candidate") {
      await entries.createIndex({ workspaceId: 1, start: -1, _id: -1 });
      await entries.createIndex({ workspaceId: 1, authorId: 1, start: -1, _id: -1 });
    }
    for (const ownOnly of [false, true]) {
      const scope = { workspaceId: "fixture", userId: "author-1", visibility: { userId: "author-1", canViewOthersTime: !ownOnly, canViewOthersMoney: true } };
      let cursor: string | undefined;
      for (const page of [1, 2]) {
        const timings: number[] = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          const began = performance.now();
          const result = await listEntries(scope, { from: "2000-01-01", to: "2999-12-31", limit: 50, ...(cursor ? { cursor } : {}) });
          timings.push(performance.now() - began);
          const key = `${ownOnly}-${page}`;
          const ids = JSON.stringify(result.entries.map((entry) => entry.id));
          if (variant === "baseline") results.set(key, ids);
          else assert.equal(ids, results.get(key), "index must preserve page contents and order");
          if (repeat === 4) cursor = result.nextCursor;
        }
        const explain = await entries.aggregate(pipeline).explain("executionStats");
        const source = explain.stages?.[0]?.$cursor ?? explain;
        timings.sort((a, b) => a - b);
        console.log(JSON.stringify({ count, variant, ownOnly, page, medianServiceMs: Number(timings[2]!.toFixed(2)), executionStats: source.executionStats, winningPlan: source.queryPlanner?.winningPlan }));
      }
    }
    // Same Mongo stages as aggregateProjects for a catalog with no budgets.
    // Settings reads and service projection are excluded from this timing.
    for (const ownOnly of [false, true]) {
      const projectPipeline = [
        { $match: { workspaceId: "fixture", archived: false } },
        { $lookup: { from: Client.collection.name, let: { cid: "$clientId" }, pipeline: [
          { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$cid"] } } },
          { $project: { _id: 0, name: 1, color: 1 } },
        ], as: "clientDoc" } },
        catalogEntryRollup({ workspaceId: "fixture", visibility: { userId: "author-1", canViewOthersTime: !ownOnly, canViewOthersMoney: true }, entryField: "projectId", as: "stats" }),
        { $addFields: { sortName: { $toLower: "$name" } } },
        { $sort: { sortName: 1 } },
      ];
      const timings: number[] = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const began = performance.now();
        const rows = await db.collection(Project.collection.name).aggregate(projectPipeline).toArray();
        assert.equal(rows.length, projectIds.length);
        timings.push(performance.now() - began);
      }
      timings.sort((a, b) => a - b);
      const explain = await db.collection(Project.collection.name).aggregate(projectPipeline).explain("executionStats");
      console.log(JSON.stringify({ count, variant, label: "projects-rollup", ownOnly, medianMongoMs: Number(timings[2]!.toFixed(2)), stages: explain.stages }));
    }
    for (const [label, filter, limit] of [
      ["recent", { workspaceId: "fixture", authorId: "author-1", start: { $gte: new Date(now.getTime() - 30 * 86400000) }, end: { $ne: null } }, 400],
      ["current", { authorId: "author-1", end: null }, 1],
    ] as const) {
      const query = entries.find(filter).limit(limit);
      if (label === "recent") query.sort({ start: -1, _id: -1 });
      const explain = await query.explain("executionStats");
      console.log(JSON.stringify({ count, variant, label, executionStats: explain.executionStats, winningPlan: explain.queryPlanner.winningPlan }));
    }
  }
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
