import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Context } from "../trpc/context.js";

process.env.STORAGE_QUOTA_BYTES = "65536";
const { allModels } = await import("../models/registry.js");
const { TimeEntry } = await import("../models/TimeEntry.js");
const { WorkspaceMember } = await import("../models/WorkspaceMember.js");
const { Project } = await import("../models/Project.js");
const { ImportBatch } = await import("../models/ImportBatch.js");
const { EntryOperation } = await import("../models/EntryOperation.js");
const { StorageUsage } = await import("../models/StorageUsage.js");
const { withBusinessTransaction } = await import("../services/business-transaction.js");
const { withEntryOperation } = await import("../services/entries/operation.js");
const { withStorageOwnershipAdoption, quotaCollections } = await import("../services/storage-quota.js");
const { entriesRouter } = await import("../trpc/routers/entries.js");
const { dataRouter } = await import("../trpc/routers/data.js");
const { ImportBudget } = await import("../models/ImportBudget.js");
const { mongooseRowStore } = await import("../services/account-deletion/stores.js");
const { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } = await import("./support/test-database.js");

const WS = "quota-a";
const OTHER = "quota-b";
const USER = "quota-owner";
const row = (n = 0, workspaceId = WS) => ({ workspaceId, authorId: USER, description: `Work ${n}`, start: new Date("2026-01-01T09:00:00Z"), end: new Date("2026-01-01T10:00:00Z"), durationSec: 3600 });
const owner = (workspaceId = WS, userId = USER) => ({ workspaceId, userId, role: "owner" as const, name: "Owner" });
const used = async (workspaceId = WS) => (await StorageUsage.findById(workspaceId).lean())?.bytes ?? 0;
const isQuota = (error: unknown) => error instanceof Error && "code" in error && error.code === "PRECONDITION_FAILED" && error.message.startsWith("Storage limit reached");

describe("account storage budgets", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("storage-quota", allModels() as never);
    assert.equal(await testDatabaseTransactions(), true, "quota safety tests require a replica set");
  });
  beforeEach(async () => { await clearTestDatabase(); await WorkspaceMember.create(owner()); });
  after(dropTestDatabase);

  it("baseline collection names match the registered models", () => {
    for (const model of allModels()) {
      const collection = quotaCollections()[model.modelName];
      if (collection) assert.equal(model.collection.collectionName, collection);
    }
  });

  it("shares a budget across owned workspaces and ordinary entry writes", async () => {
    await WorkspaceMember.create(owner(OTHER));
    await TimeEntry.insertMany(Array.from({ length: 7 }, (_, n) => row(n)));
    await TimeEntry.insertMany(Array.from({ length: 7 }, (_, n) => row(n, OTHER)));
    assert.equal(await used() + await used(OTHER), 65536);
    await assert.rejects(TimeEntry.create(row(9)), isQuota);
    await assert.rejects(TimeEntry.create(row(9, OTHER)), isQuota);
    assert.equal(await TimeEntry.countDocuments({}), 14);
  });

  it("serializes concurrent writers at the account boundary", async () => {
    await WorkspaceMember.create(owner(OTHER));
    await TimeEntry.insertMany(Array.from({ length: 13 }, (_, n) => row(n)));
    const results = await Promise.allSettled([TimeEntry.create(row(20)), TimeEntry.create(row(21, OTHER))]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(isQuota(failed.reason));
    assert.equal(await used() + await used(OTHER), 65536);
  });

  it("rolls back catalog, receipt and entry changes as one import", async () => {
    await TimeEntry.insertMany(Array.from({ length: 14 }, (_, n) => row(n)));
    await assert.rejects(withBusinessTransaction(async () => {
      await Project.create({ workspaceId: WS, name: "Imported project" });
      await ImportBatch.create({ workspaceId: WS, filename: "history.json" });
      await TimeEntry.create(row(99));
    }), isQuota);
    assert.equal(await Project.countDocuments({}), 0);
    assert.equal(await ImportBatch.countDocuments({}), 0);
    assert.equal(await TimeEntry.countDocuments({}), 14);
    assert.equal(await used(), 15 * 4096);
  });

  it("refuses an oversized cumulative import through the real router without partial writes", async () => {
    const context = { user: { id: USER, name: "Owner", email: "owner@example.test" }, session: { user: { id: USER } }, activeWorkspaceId: WS, req: undefined, res: undefined, authMethod: "cookie" } as unknown as Context;
    const text = JSON.stringify({ entries: Array.from({ length: 15 }, (_, n) => ({ ...row(n), projectName: "New imported project" })) });
    await assert.rejects(dataRouter.createCaller(context).commit({ workspaceId: WS, text, timeZone: "UTC" }), isQuota);
    assert.equal(await TimeEntry.countDocuments({}), 0);
    assert.equal(await Project.countDocuments({}), 0);
    assert.equal(await ImportBatch.countDocuments({}), 0);
    assert.equal(await used(), 4096);
    assert.equal((await ImportBudget.findOne({}).lean())?.attempts, 1, "failed import still consumes upload budget");
  });

  it("accounts retained receipts, even after their entries are removed", async () => {
    for (let n = 0; n < 15; n++) await ImportBatch.create({ workspaceId: WS, filename: `${n}.csv`, undoneAt: new Date() });
    await assert.rejects(ImportBatch.create({ workspaceId: WS }), isQuota);
    assert.equal(await used(), 65536);
  });

  it("stops a timer and writes its replay receipt at the budget limit", async () => {
    await TimeEntry.insertMany(Array.from({ length: 12 }, (_, n) => row(n)));
    const timer = await TimeEntry.create({ ...row(20), end: null });
    assert.equal(await used(), 65536);
    await withEntryOperation({ userId: USER, workspaceId: WS }, "stop", { operationId: "stop-one" }, async () => {
      await TimeEntry.updateOne({ _id: timer._id }, { $set: { end: new Date("2026-01-01T11:00:00Z"), durationSec: 7200 } });
      return { id: String(timer._id), stopped: true };
    });
    assert.ok((await TimeEntry.findById(timer._id))?.end);
    assert.equal(await EntryOperation.countDocuments({}), 1);
    assert.ok(await used() <= 65536);
  });

  it("deletes through durable replay at a full budget", async () => {
    const entries = await TimeEntry.insertMany(Array.from({ length: 15 }, (_, n) => row(n)));
    await withEntryOperation({ userId: USER, workspaceId: WS }, "delete", { operationId: "delete-one" }, async () => {
      await TimeEntry.deleteOne({ _id: entries[0]!._id });
      return { deleted: true };
    });
    assert.equal(await TimeEntry.countDocuments({}), 14);
    assert.equal(await used(), 65536);
  });

  for (const includeId of [true, false]) it(`stops a timer ${includeId ? "by id" : "without an id"} in another owner's workspace while the selected workspace is full`, async () => {
    await WorkspaceMember.create(owner(OTHER, "other-owner"));
    await WorkspaceMember.create({ ...owner(OTHER), role: "member" });
    await TimeEntry.insertMany(Array.from({ length: 15 }, (_, n) => row(n)));
    const running = await TimeEntry.create({ ...row(21, OTHER), end: null });
    const context = { user: { id: USER, name: "Owner", email: "owner@example.test" }, session: { user: { id: USER } }, activeWorkspaceId: WS, req: undefined, res: undefined, authMethod: "cookie" } as unknown as Context;
    const caller = entriesRouter.createCaller(context);
    const input = { operation: "entries.stop" as const, operationId: randomUUID(), workspaceId: WS, input: { ...(includeId ? { id: String(running._id) } : {}), end: "2026-01-01T11:00:00Z" } };
    const stopped = await caller.applyOperation(input);
    assert.deepEqual(await caller.applyOperation(input), stopped, "replay remains keyed to the requested workspace");
    assert.ok((await TimeEntry.findById(running._id))?.end);
    assert.equal(await used(), 65536);
    assert.equal((await EntryOperation.findOne({ userId: USER }).lean())?.workspaceId, OTHER);
  });

  it("measures updates by id when an updated field no longer matches the filter", async () => {
    const receipt = await EntryOperation.create({ _id: "receipt", workspaceId: WS, userId: USER, requestHash: "h", operation: "create", result: {} });
    const before = await used();
    await EntryOperation.updateOne({ _id: receipt._id, operation: "create" }, { $set: { operation: "changed", result: { text: "x".repeat(10_000) } } });
    assert.ok(await used() > before + 5000);
    await EntryOperation.deleteOne({ _id: receipt._id });
    assert.equal(await used(), 4096);
  });

  it("seeds pre-existing data and allows shrinking an over-budget account", async () => {
    // Simulate pre-feature records, intentionally bypassing model accounting.
    await TimeEntry.collection.insertMany(Array.from({ length: 18 }, (_, n) => row(n)));
    await StorageUsage.deleteMany({});
    await assert.rejects(TimeEntry.create(row(30)), isQuota);
    assert.equal(await TimeEntry.countDocuments({}), 18);
    await TimeEntry.deleteMany({ workspaceId: WS });
    assert.equal(await used(), 4096);
    await TimeEntry.create(row(31));
    assert.equal(await used(), 8192);
  });

  it("rejects owner promotion that would exceed the recipient account budget", async () => {
    await WorkspaceMember.create(owner(OTHER, "other-owner"));
    await TimeEntry.insertMany(Array.from({ length: 10 }, (_, n) => row(n)));
    await TimeEntry.insertMany(Array.from({ length: 6 }, (_, n) => ({ ...row(n, OTHER), authorId: "other-owner" })));
    const member = await WorkspaceMember.create({ ...owner(OTHER), role: "member" });
    await assert.rejects(WorkspaceMember.updateOne({ _id: member._id }, { $set: { role: "owner" } }), isQuota);
    assert.equal((await WorkspaceMember.findById(member._id))?.role, "member");
  });

  it("rejects unknown mutation forms without changing data", async () => {
    const entry = await TimeEntry.create(row());
    await assert.rejects(TimeEntry.updateOne({ _id: entry._id }, [{ $set: { description: "pipeline" } }], { updatePipeline: true }));
    await assert.rejects(TimeEntry.bulkWrite([{ insertOne: { document: row(99) } }]));
    assert.equal(await TimeEntry.countDocuments({}), 1);
  });

  it("permits account-erasure succession over quota without permitting new storage", async () => {
    await WorkspaceMember.create(owner(OTHER, "departing-owner"));
    await TimeEntry.insertMany(Array.from({ length: 10 }, (_, n) => row(n)));
    await TimeEntry.insertMany(Array.from({ length: 6 }, (_, n) => ({ ...row(n, OTHER), authorId: "departing-owner" })));
    const member = await WorkspaceMember.create({ ...owner(OTHER), role: "member" });
    await withStorageOwnershipAdoption(() => WorkspaceMember.updateOne({ _id: member._id }, { $set: { role: "owner" } }).exec());
    assert.equal((await WorkspaceMember.findById(member._id))?.role, "owner");
    await assert.rejects(TimeEntry.create(row(90)), isQuota);
    await assert.rejects(withStorageOwnershipAdoption(() => TimeEntry.create(row(91))), /cannot add stored content/);
    await TimeEntry.deleteMany({ workspaceId: OTHER });
    await TimeEntry.create(row(92));
  });

  it("removes the final workspace ledger atomically with account-erasure membership removal", async () => {
    assert.equal(await used(), 4096);
    await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: WS });
    assert.equal(await WorkspaceMember.countDocuments({}), 0);
    assert.equal(await StorageUsage.findById(WS), null);
  });
});
