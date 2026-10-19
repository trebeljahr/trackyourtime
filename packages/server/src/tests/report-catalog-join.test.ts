// The reports join an entry to its project, task and client in JS, once per
// id a report meets, instead of three `$lookup` sub-queries per entry. The
// promise: the same joined rows the lookups produced, for every shape of
// reference a stored entry can carry. The oracle below is the pipeline the
// join replaced, run against a real MongoDB, so `$convert` and `$lookup`
// answer for themselves rather than as this file remembers them.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose, { Types, type PipelineStage } from "mongoose";
import { Client } from "../models/Client.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { entryClientExpression } from "../services/entries/refs.js";
import { createCatalogJoin } from "../trpc/routers/reports.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const WORKSPACE = "ws_join";
const OTHER = "ws_other";

const convert = (input: unknown): Record<string, unknown> => ({
  $convert: { input, to: "objectId", onError: null, onNull: null },
});

/** The lookups `createCatalogJoin` replaced, verbatim in effect. */
const ORACLE: PipelineStage[] = [
  { $addFields: { projectOid: convert("$projectId"), taskOid: convert("$taskId") } },
  { $lookup: { from: Project.collection.name, localField: "projectOid", foreignField: "_id", as: "projectDocs" } },
  { $lookup: { from: Task.collection.name, localField: "taskOid", foreignField: "_id", as: "taskDocs" } },
  {
    $addFields: {
      project: { $arrayElemAt: ["$projectDocs", 0] },
      task: { $arrayElemAt: ["$taskDocs", 0] },
    },
  },
  { $addFields: { clientOid: convert(entryClientExpression) } },
  { $lookup: { from: Client.collection.name, localField: "clientOid", foreignField: "_id", as: "clientDocs" } },
  { $addFields: { client: { $arrayElemAt: ["$clientDocs", 0] } } },
  { $project: { projectDocs: 0, taskDocs: 0, clientDocs: 0, projectOid: 0, taskOid: 0, clientOid: 0 } },
];

const id = (): Types.ObjectId => new Types.ObjectId();
const catalog = (workspaceId: string, name: string, extra: Record<string, unknown> = {}) => ({
  _id: id(),
  workspaceId,
  createdBy: "u1",
  name,
  color: "#123456",
  archived: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...extra,
});

describe("createCatalogJoin", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("report-catalog-join");
  });
  after(dropTestDatabase);
  beforeEach(clearTestDatabase);

  it("joins every shape of reference exactly as the lookups did", async () => {
    const db = mongoose.connection.db!;
    const c1 = catalog(WORKSPACE, "Client one");
    const c2 = catalog(WORKSPACE, "Client two");
    const cOther = catalog(OTHER, "Somebody else's client");
    const hex = (doc: { _id: Types.ObjectId }): string => doc._id.toHexString();
    const p1 = catalog(WORKSPACE, "Plain", { clientId: hex(c1) });
    const pNullClient = catalog(WORKSPACE, "No client", { clientId: null });
    const pNoClientField = catalog(WORKSPACE, "Legacy, no client field");
    const pUpperClient = catalog(WORKSPACE, "Upper-case client", { clientId: hex(c1).toUpperCase() });
    const pTypedClient = catalog(WORKSPACE, "ObjectId client", { clientId: c2._id });
    const pJunkClient = catalog(WORKSPACE, "Junk client", { clientId: "junk" });
    const pOther = catalog(OTHER, "Somebody else's project", { clientId: hex(cOther) });
    const t1 = catalog(WORKSPACE, "Task");
    const tOther = catalog(OTHER, "Somebody else's task");
    await db.collection(Client.collection.name).insertMany([c1, c2, cOther]);
    await db
      .collection(Project.collection.name)
      .insertMany([p1, pNullClient, pNoClientField, pUpperClient, pTypedClient, pJunkClient, pOther]);
    await db.collection(Task.collection.name).insertMany([t1, tOther]);

    const dangling = id().toHexString();
    const refs: Record<string, unknown>[] = [
      { projectId: hex(p1), taskId: hex(t1) },
      { projectId: hex(p1).toUpperCase(), taskId: hex(t1).toUpperCase() },
      { projectId: p1._id, taskId: t1._id },
      { projectId: hex(p1).slice(0, 12), taskId: "abcdefabcdef" },
      { projectId: "not-an-id", taskId: "" },
      { projectId: 42, taskId: true },
      { projectId: null, taskId: null },
      { taskId: null },
      { projectId: null, taskId: null, clientId: hex(c2) },
      { projectId: null, taskId: null, clientId: c2._id },
      { projectId: null, taskId: null, clientId: hex(c2).toUpperCase() },
      { projectId: hex(p1), taskId: null, clientId: null },
      { projectId: hex(p1), taskId: null, clientId: "garbage" },
      { projectId: hex(p1), taskId: null, clientId: hex(cOther) },
      { projectId: hex(pNullClient), taskId: null },
      { projectId: hex(pNoClientField), taskId: null },
      { projectId: hex(pUpperClient), taskId: null },
      { projectId: hex(pTypedClient), taskId: null },
      { projectId: hex(pJunkClient), taskId: null },
      { projectId: hex(pOther), taskId: hex(tOther) },
      { projectId: dangling, taskId: dangling, clientId: dangling },
      { projectId: dangling, taskId: null },
    ];
    const start = Date.parse("2026-09-01T08:00:00.000Z");
    await db.collection(TimeEntry.collection.name).insertMany(
      refs.map((ref, n) => ({
        workspaceId: WORKSPACE,
        authorId: "u1",
        description: `Row ${n}`,
        billable: true,
        start: new Date(start + n * 3_600_000),
        end: new Date(start + n * 3_600_000 + 1_800_000),
        durationSec: 1800,
        hourlyRate: null,
        currency: "EUR",
        source: "web",
        timeZone: null,
        tagIds: [],
        ...ref,
      })),
    );

    const page: PipelineStage[] = [{ $match: { workspaceId: WORKSPACE } }, { $sort: { start: -1, _id: -1 } }];
    const expected = await TimeEntry.aggregate([...page, ...ORACLE]);
    const rows = await TimeEntry.aggregate<Parameters<ReturnType<typeof createCatalogJoin>>[0][number]>(page);
    // Twice through one join: the second pass answers from its cache.
    const join = createCatalogJoin();
    assert.deepStrictEqual(await join(rows), expected);
    assert.deepStrictEqual(await join(rows), expected);
    assert.equal(expected.length, refs.length);
    // The oracle really joined something of each kind.
    assert.ok(expected.some((row) => row.project && row.task && row.client));
    assert.ok(expected.some((row) => !("project" in row) && row.client));
  });
});
