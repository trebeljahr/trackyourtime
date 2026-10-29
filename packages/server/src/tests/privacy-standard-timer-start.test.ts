import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { encodeSecret, randomSecret } from "@starter/core";
import { TimeEntry } from "../models/TimeEntry.js";
import { EntryOperation } from "../models/EntryOperation.js";
import { PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { allModels } from "../models/registry.js";
import { standardAccountCurrentTimer } from "../services/privacy/standard-timer-current.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { startCoordinatedStandardTimer } from "../services/privacy/standard-timer-start.js";
import { withBusinessTransaction } from "../services/business-transaction.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } from "./support/test-database.js";
const scope = { userId: "owner", workspaceId: "standard" };
const input = { description: "Standard handoff body", start: "2026-10-29T01:00:00.000Z", source: "desktop" as const, timeZone: "UTC" };
const entryId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 24);
describe("internal standard half of a private timer handoff", { skip: skipWithoutDatabase }, () => {
  before(async () => { await connectTestDatabase("private-standard-timer-start", allModels() as never); await testDatabaseTransactions(); });
  beforeEach(async () => { await clearTestDatabase(); await WorkspaceMember.create({ ...scope, role: "owner", name: "Owner" }); });
  after(dropTestDatabase);
  it("uses the saved entry identity and receipt without recreating a timer after a later stop", async () => {
    const id = entryId(), operationId = crypto.randomUUID(), saved = await startCoordinatedStandardTimer(scope, input, id, operationId);
    assert.equal(saved.id, id); assert.equal(saved.description, input.description);
    assert.deepEqual(await startCoordinatedStandardTimer(scope, input, id, operationId), saved); assert.equal(await TimeEntry.countDocuments(), 1); assert.equal(await EntryOperation.countDocuments(), 1);
    await TimeEntry.updateOne({ _id: id }, { $set: { end: new Date("2026-10-29T02:00:00.000Z") } });
    assert.deepEqual(await startCoordinatedStandardTimer(scope, input, id, operationId), saved); assert.notEqual((await TimeEntry.findById(id).lean())!.end, null);
  });
  it("keeps changed standard content and identity from reusing a successful operation", async () => {
    const id = entryId(), operationId = crypto.randomUUID(); await startCoordinatedStandardTimer(scope, input, id, operationId);
    await assert.rejects(startCoordinatedStandardTimer(scope, { ...input, description: "Different body" }, id, operationId), { code: "CONFLICT" });
    await assert.rejects(startCoordinatedStandardTimer(scope, input, entryId(), operationId), { code: "CONFLICT" });
    assert.equal(await TimeEntry.countDocuments(), 1); assert.equal(await EntryOperation.countDocuments(), 1);
  });
  it("refuses to silently stop a standard timer outside the declared private predecessor", async () => {
    const running = await TimeEntry.create({ workspaceId: scope.workspaceId, authorId: scope.userId, description: "Original running time", start: new Date(input.start), end: null });
    await assert.rejects(startCoordinatedStandardTimer(scope, input, entryId(), crypto.randomUUID()), { code: "CONFLICT" });
    assert.equal((await TimeEntry.findById(running._id).lean())!.end, null); assert.equal(await TimeEntry.countDocuments(), 1); assert.equal(await EntryOperation.countDocuments(), 0);
  });
  it("rolls its entry and receipt back with the enclosing account transaction", async () => {
    await assert.rejects(withBusinessTransaction(async () => { await startCoordinatedStandardTimer(scope, input, entryId(), crypto.randomUUID()); throw new Error("Synthetic account rollback"); }), /Synthetic account rollback/);
    assert.equal(await TimeEntry.countDocuments(), 0); assert.equal(await EntryOperation.countDocuments(), 0);
  });
  it("checks current membership and standard storage before reading a retained receipt", async () => {
    const id = entryId(), operationId = crypto.randomUUID(); await startCoordinatedStandardTimer(scope, input, id, operationId);
    await WorkspaceMember.deleteMany(scope); await assert.rejects(startCoordinatedStandardTimer(scope, input, id, operationId), { code: "NOT_FOUND" });
    await WorkspaceMember.create({ ...scope, role: "owner", name: "Owner" });
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: scope.userId, state: "encrypted", revision: 1, head: encodeSecret(randomSecret()), directoryDigest: encodeSecret(randomSecret()), migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date() });
    await assert.rejects(startCoordinatedStandardTimer(scope, input, id, operationId), { code: "PRECONDITION_FAILED" });
  });
  it("refuses a colliding entry identity without modifying the original row or leaving a receipt", async () => {
    const id = entryId(); await TimeEntry.create({ _id: id, workspaceId: "foreign", authorId: "another", description: "Unrelated time", start: new Date(input.start), end: new Date("2026-10-29T02:00:00.000Z") });
    await assert.rejects(startCoordinatedStandardTimer(scope, input, id, crypto.randomUUID()), { code: "CONFLICT" });
    assert.equal((await TimeEntry.findById(id).lean())!.description, "Unrelated time"); assert.equal(await EntryOperation.countDocuments(), 0);
  });
  it("requires the original captured timestamp and refuses extra payload fields before creating anything", async () => {
    await assert.rejects(startCoordinatedStandardTimer(scope, { description: "No timestamp" } as never, entryId(), crypto.randomUUID()));
    await assert.rejects(startCoordinatedStandardTimer(scope, { ...input, operationId: crypto.randomUUID() } as never, entryId(), crypto.randomUUID()));
    assert.equal(await TimeEntry.countDocuments(), 0); assert.equal(await EntryOperation.countDocuments(), 0);
  });
  it("reads only the authenticated person's actual standard timer regardless of the selected workspace", async () => {
    assert.equal(await standardAccountCurrentTimer(scope.userId), null);
    const saved = await startCoordinatedStandardTimer(scope, input, entryId(), crypto.randomUUID());
    const caller = privacyRouter.createCaller({ user: { id: scope.userId }, session: { user: { id: scope.userId } }, activeWorkspaceId: "private-selected" } as unknown as Context);
    assert.equal((await caller.standardCurrentTimer())!.id, saved.id);
    const other = privacyRouter.createCaller({ user: { id: "other" }, session: { user: { id: "other" } } } as unknown as Context);
    assert.equal(await other.standardCurrentTimer(), null);
    await assert.rejects(other.standardCurrentTimer({ userId: scope.userId } as never), { code: "BAD_REQUEST" });
    const anonymous = privacyRouter.createCaller({ user: null, session: null } as unknown as Context);
    await assert.rejects(anonymous.standardCurrentTimer(), { code: "UNAUTHORIZED" });
    await WorkspaceMember.deleteMany(scope); await assert.rejects(caller.standardCurrentTimer(), { code: "NOT_FOUND" });
    assert.equal((await TimeEntry.findById(saved.id).lean())!.end, null);
  });
  it("refuses retained original bodies in a private actual workspace before runaway processing", async () => {
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: scope.userId, state: "encrypted", revision: 1, head: encodeSecret(randomSecret()), directoryDigest: encodeSecret(randomSecret()), migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date() });
    const original = { workspaceId: scope.workspaceId, authorId: scope.userId, description: "Original retained text", start: new Date("2020-01-01T01:00:00.000Z"), end: null, createdAt: new Date(), updatedAt: new Date() };
    const { insertedId } = await TimeEntry.collection.insertOne(original as never);
    await assert.rejects(standardAccountCurrentTimer(scope.userId), { code: "PRECONDITION_FAILED", message: "PRIVATE_WORKSPACE_REQUIRES_UNLOCK" });
    const after = await TimeEntry.collection.findOne({ _id: insertedId }); assert.equal(after!.end, null); assert.equal(after!.runaway, undefined); assert.equal(after!.reminderSentAt, undefined);
  });
});
