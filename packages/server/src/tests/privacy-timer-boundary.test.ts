import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { PRIVATE_WORKSPACE_REQUIRED } from "@starter/shared";
import { allModels } from "../models/registry.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { EntryOperation } from "../models/EntryOperation.js";
import { entriesRouter } from "../trpc/routers/entries.js";
import { currentEntry, personReach, workspaceReach } from "../services/entries/timer.js";
import { fenceWorkspace, transactionSession, withBusinessTransaction } from "../services/business-transaction.js";
import { withEntryOperation } from "../services/entries/operation.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } from "./support/test-database.js";
const standard = "standard", privateId = "private", userId = "owner", refused = { code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED };
const scope = { workspaceId: standard, userId, visibility: { userId, canViewOthersTime: true, canViewOthersMoney: true } };
const caller = () => entriesRouter.createCaller({ user: { id: userId, name: "Synthetic owner", email: "owner@example.test" }, session: { user: { id: userId } }, activeWorkspaceId: standard, authMethod: "cookie" } as Context);
// Model retained originals directly; public conversion remains disabled.
const freeze = (state: "encrypted" | "migrating" | "reserved" = "encrypted") => withBusinessTransaction(async () => {
  await fenceWorkspace(privateId);
  return mongoose.connection.db!.collection("privateworkspaces").insertOne({ workspaceId: privateId, ownerId: userId, state, migrationId: randomUUID(), leaseUntil: new Date(Date.now() + 3600000) }, { session: transactionSession() });
});
describe("cross-workspace plaintext timer boundaries", { skip: skipWithoutDatabase }, () => {
  before(async () => { await connectTestDatabase("private-timer-boundary", allModels() as never); await testDatabaseTransactions(); });
  beforeEach(async () => { await clearTestDatabase(); await WorkspaceMember.create([standard, privateId].map(workspaceId => ({ workspaceId, userId, role: "owner" as const, name: "Synthetic owner" }))); });
  after(dropTestDatabase);
  for (const mode of ["migrating", "encrypted", "reserved"] as const) it(`refuses a person-wide current read of retained ${mode} originals from a standard workspace`, async () => {
    const running = await TimeEntry.create({ workspaceId: privateId, authorId: userId, description: "Retained private original", start: new Date(Date.now() - 48 * 3600000), end: null });
    await freeze(mode); const before = await TimeEntry.findById(running._id).lean();
    await assert.rejects(caller().current({ workspaceId: standard }), refused);
    assert.deepEqual(await TimeEntry.findById(running._id).lean(), before); assert.equal(await EntryOperation.countDocuments(), 0);
  });
  it("keeps ordinary cross-workspace person reads and confined token reads distinct", async () => {
    const running = await TimeEntry.create({ workspaceId: privateId, authorId: userId, description: "Ordinary standard timer", start: new Date(), end: null });
    assert.equal((await currentEntry(scope, personReach))?.id, String(running._id)); assert.equal(await currentEntry(scope, workspaceReach(standard)), null);
    await freeze(); assert.equal(await currentEntry(scope, workspaceReach(standard)), null); await assert.rejects(currentEntry(scope, workspaceReach(privateId)), refused);
  });
  for (const kind of ["stop", "discard"] as const) it(`revalidates a retained cross-workspace ${kind} receipt before returning its result`, async () => {
    const running = await TimeEntry.create({ workspaceId: privateId, authorId: userId, description: "Private receipt original", start: new Date(Date.now() - 10000), end: null });
    const input = { operationId: randomUUID(), id: String(running._id), ...(kind === "stop" ? { end: new Date().toISOString() } : {}) };
    const first = await caller()[kind](input); assert.deepEqual(await caller()[kind](input), first);
    await freeze(); const before = await EntryOperation.find().lean(); await assert.rejects(caller()[kind](input), refused); assert.deepEqual(await EntryOperation.find().lean(), before);
  });
  it("revalidates the workspace of an embedded replacement notice in a legacy start receipt", async () => {
    const input = { operationId: randomUUID(), description: "Standard timer" }, result = { workspaceId: standard, replaced: { workspaceId: privateId, workspaceName: "Private original workspace name" } };
    await withEntryOperation(scope, "entries.start", input, async () => result); await freeze(); let called = false;
    await assert.rejects(withEntryOperation(scope, "entries.start", input, async () => { called = true; return result; }), refused); assert.equal(called, false);
  });
  it("validates the actual result workspace even when a legacy receipt was charged to the request workspace", async () => {
    const input = { operationId: randomUUID() }, result = { workspaceId: privateId, description: "Private result" };
    await withEntryOperation(scope, "entries.stop", input, async () => result); await freeze();
    await assert.rejects(withEntryOperation(scope, "entries.stop", input, async () => result), refused);
  });
  for (const key of ["entry", "stopped"] as const) it(`checks a nested ${key} snapshot in retained timer-operation results`, async () => {
    const input = { operationId: randomUUID() }, result = { [key]: { workspaceId: privateId, description: "Retained private timer snapshot" } };
    await withEntryOperation(scope, "entries.start", input, async () => result); await freeze();
    await assert.rejects(withEntryOperation(scope, "entries.start", input, async () => result), refused);
  });
  for (const operation of ["current", "receipt"] as const) it(`retries a ${operation} with a stale transaction snapshot after the actual workspace is frozen`, async () => {
    await TimeEntry.create({ workspaceId: privateId, authorId: userId, start: new Date(), end: null });
    const input = { operationId: randomUUID() }; await withEntryOperation(scope, "entries.start", input, async () => ({ workspaceId: standard, replaced: { workspaceId: privateId, workspaceName: "Private original" } }));
    let enter!: () => void, resume!: () => void, attempts = 0; const ready = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    const reader = withBusinessTransaction(async () => {
      attempts++; await TimeEntry.findOne({ authorId: userId }).lean(); if (attempts === 1) { enter(); await gate; }
      return operation === "current" ? currentEntry(scope, personReach) : withEntryOperation(scope, "entries.start", input, async () => { throw new Error("Must not repeat work"); });
    });
    await ready; await freeze(); resume(); await assert.rejects(reader, refused); assert.ok(attempts >= 2);
  });
  it("refuses malformed legacy result scopes instead of returning unbound timer content", async () => {
    for (const result of [{ workspaceId: 17 }, { replaced: { workspaceName: "Unbound original name" } }]) {
      const input = { operationId: randomUUID() }; await withEntryOperation(scope, "entries.start", input, async () => result);
      await assert.rejects(withEntryOperation(scope, "entries.start", input, async () => result), { code: "PRECONDITION_FAILED" });
    }
  });
  it("refuses a receipt whose author differs from its original key", async () => {
    const input = { operationId: randomUUID() }; await withEntryOperation(scope, "entries.create", input, async () => ({ workspaceId: standard }));
    const key = createHash("sha256").update(JSON.stringify([userId, standard, input.operationId])).digest("hex");
    await mongoose.connection.db!.collection("entryoperations").updateOne({ _id: key } as never, { $set: { userId: "other" } });
    await assert.rejects(withEntryOperation(scope, "entries.create", input, async () => ({})), { code: "FORBIDDEN" });
  });
});
