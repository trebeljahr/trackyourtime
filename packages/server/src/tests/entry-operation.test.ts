import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { EntryOperation } from "../models/EntryOperation.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { allModels } from "../models/registry.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { entriesRouter } from "../trpc/routers/entries.js";
import { withEntryOperation } from "../services/entries/operation.js";
import { supportsBusinessTransactions } from "../services/business-transaction.js";
import { startTimerDetailed, personReach } from "../services/entries/timer.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const workspaceId = "receipt-workspace", userId = "receipt-author";
const actor = { workspaceId, userId, role: "owner" as const,
  visibility: { userId, canViewOthersTime: true, canViewOthersMoney: true } };
const context = (): Context => ({ user: { id: userId, name: "Fixture", email: "fixture@example.test" },
  session: { user: { id: userId } }, activeWorkspaceId: workspaceId, authMethod: "cookie" }) as Context;
const client = () => entriesRouter.createCaller(context());
const input = () => ({ workspaceId, operationId: randomUUID(), description: "Synthetic receipt",
  start: "2026-10-04T01:00:00.000Z", end: "2026-10-04T02:00:00.000Z", billable: false });
let transactions = false;

describe("durable entry operations", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("entry-operation", allModels() as never);
    transactions = await supportsBusinessTransactions();
  });
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create({ workspaceId, userId, role: "owner", name: "Fixture",
      canViewOthersTime: true, canViewOthersMoney: true });
  });
  after(dropTestDatabase);

  it("refuses durable replay before writes on standalone; legacy writes remain usable", async () => {
    if (transactions) return;
    await assert.rejects(client().create(input()), { message: "DURABLE_REPLAY_REQUIRES_REPLICA_SET" });
    assert.equal(await TimeEntry.countDocuments(), 0);
    assert.equal(await EntryOperation.countDocuments(), 0);
    const { operationId: _, ...legacy } = input();
    await client().create(legacy);
    assert.equal(await TimeEntry.countDocuments(), 1);
  });


  it("dedicated operation route requires identity and guards mixed-version retries", async (t) => {
    const request = input();
    const { operationId, workspaceId: workspace, ...payload } = request;
    const durable = { operation: "entries.create" as const, operationId, workspaceId: workspace, input: payload };
    if (!transactions) {
      await assert.rejects(client().applyOperation(durable), { message: "DURABLE_REPLAY_REQUIRES_REPLICA_SET" });
      assert.equal(await TimeEntry.countDocuments(), 0); return;
    }
    const first = await client().applyOperation(durable);
    assert.deepEqual(await client().applyOperation(durable), first);
    assert.equal(await TimeEntry.countDocuments(), 1);
    await assert.rejects(client().applyOperation({ ...durable, operationId: undefined } as never), (error: unknown) => (error as { code: string }).code === "BAD_REQUEST");
    assert.equal(await TimeEntry.countDocuments(), 1);
  });

  it("one committed result survives a dropped response and concurrent retries", async (t) => {
    if (!transactions) return t.skip("replica set required");
    const request = input();
    const results = await Promise.all(Array.from({ length: 8 }, () => client().create(request)));
    assert.equal(new Set(results.map((row) => row.id)).size, 1);
    assert.equal(await TimeEntry.countDocuments(), 1);
    assert.equal(await EntryOperation.countDocuments(), 1);
    assert.deepEqual(await client().create(request), results[0]);
    await assert.rejects(client().create({ ...request, description: "Changed" }), { message: "OPERATION_ID_REUSED" });
    await assert.rejects(client().remove({ operationId: request.operationId, id: results[0]!.id }), { message: "OPERATION_ID_REUSED" });
  });

  it("all six queued operations replay without another write, even after deletion", async (t) => {
    if (!transactions) return t.skip("replica set required");
    const create = input();
    const made = await client().create(create);
    const update = { workspaceId, id: made.id, description: "Updated", operationId: randomUUID() };
    assert.deepEqual(await client().update(update), await client().update(update));
    const remove = { workspaceId, id: made.id, operationId: randomUUID() };
    assert.deepEqual(await client().remove(remove), await client().remove(remove));
    assert.equal((await client().create(create)).id, made.id);
    assert.equal(await TimeEntry.countDocuments(), 0, "a delayed create must not resurrect a deleted entry");
    const start = { workspaceId, description: "Running", start: new Date().toISOString(), operationId: randomUUID() };
    const running = await client().start(start);
    assert.deepEqual(await client().start(start), running);
    const stop = { workspaceId, id: running.id, end: new Date(Date.now() + 1000).toISOString(), operationId: randomUUID() };
    assert.deepEqual(await client().stop(stop), await client().stop(stop));
    await client().remove({ id: running.id });
    const disposable = await client().start({ description: "Discard", start: new Date().toISOString() });
    const discard = { workspaceId, id: disposable.id, operationId: randomUUID() };
    assert.deepEqual(await client().discard(discard), await client().discard(discard));
    assert.equal(await TimeEntry.countDocuments(), 0);
    assert.equal(await EntryOperation.countDocuments(), 6);
  });

  it("rechecks current membership and session before reading a receipt", async (t) => {
    if (!transactions) return t.skip("replica set required");
    const request = input(); await client().create(request);
    await WorkspaceMember.deleteMany({ userId });
    await assert.rejects(client().create(request), (error: unknown) => (error as { code: string }).code === "NOT_FOUND");
    const signedOut = entriesRouter.createCaller({ ...context(), user: null, session: null });
    await assert.rejects(signedOut.create(request), (error: unknown) => (error as { code: string }).code === "UNAUTHORIZED");
  });

  it("rolls back timer replacement and its receipt together after interrupted work", async (t) => {
    if (!transactions) return t.skip("replica set required");
    const previous = await client().start({ description: "Previous", start: new Date().toISOString() });
    const request = { operationId: randomUUID(), description: "Replacement", start: new Date(Date.now() + 1000).toISOString() };
    await assert.rejects(withEntryOperation(actor, "test-replacement", request, async () => {
      await startTimerDetailed(actor, request, personReach);
      throw new Error("simulated interruption before commit");
    }), /simulated interruption/);
    assert.equal(await EntryOperation.countDocuments(), 0);
    assert.equal(await TimeEntry.countDocuments(), 1);
    assert.equal((await client().current({ workspaceId }))?.id, previous.id);
    const result = await withEntryOperation(actor, "test-replacement", request, () => startTimerDetailed(actor, request, personReach));
    assert.notEqual(result.entry.id, previous.id);
    assert.equal(await TimeEntry.countDocuments(), 2);
    assert.equal(await EntryOperation.countDocuments(), 1);
  });
});
