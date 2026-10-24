import assert from "node:assert/strict";
import { before, after, beforeEach, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import type { Request, Response } from "express";
import { PRIVATE_WORKSPACE_REQUIRED } from "@starter/shared";
import { Client } from "../models/Client.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";
import { ApiToken } from "../models/ApiToken.js";
import { PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { StorageFence, StorageUsage } from "../models/StorageUsage.js";
import { withBusinessTransaction, fenceWorkspace } from "../services/business-transaction.js";
import { withPrivateWorkspaceErasure } from "../services/privacy/plaintext-guard.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { claimDueDeliveries } from "../services/webhooks/delivery.js";
import { clientsRouter } from "../trpc/routers/clients.js";
import type { Context } from "../trpc/context.js";
import { mintApiToken } from "../auth/api-token.js";
import { requireApiToken } from "../api/v1/auth.js";
import { problemFromTRPCError } from "../api/v1/problem.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const WS = "private-a", OTHER = "standard-b", USER = "owner";
const refused = { code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED };
async function freeze(workspaceId = WS, state: "migrating" | "encrypted" = "migrating") {
  await withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    await PrivateWorkspace.create({ workspaceId, ownerId: USER, state, revision: 0, leaseUntil: new Date(Date.now() + 3600000), migrationId: crypto.randomUUID(), sourceRevision: "0".repeat(64) });
  });
}
const delivery = (workspaceId: string) => ({ workspaceId, subscriptionId: "subscription", event: "entry.created" as const, envelope: { workspaceId, description: "synthetic private payload" }, nextAttemptAt: new Date(0) });
describe("plaintext workspace migration barrier", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-plaintext-guard", [Client, WorkspaceMember, WebhookDelivery, ApiToken, PrivateWorkspace, WorkspaceWriteFence, StorageFence, StorageUsage] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create([{ workspaceId: WS, userId: USER, role: "owner", name: "Owner" }, { workspaceId: OTHER, userId: USER, role: "owner", name: "Owner" }]);
  });
  after(dropTestDatabase);
  it("refuses direct plaintext writes and legacy reads while preserving the source records", async () => {
    const row = await Client.create({ workspaceId: WS, name: "original" }); await freeze();
    row.name = "changed";
    for (const write of [() => row.save(), () => Client.updateOne({ _id: row._id }, { $set: { name: "changed" } }), () => Client.findOneAndUpdate({ _id: row._id }, { $set: { name: "changed" } }), () => Client.deleteMany({ workspaceId: WS }), () => Client.insertMany([{ workspaceId: WS, name: "new" }]), () => Client.bulkWrite([{ updateOne: { filter: { _id: row._id }, update: { $set: { name: "changed" } } } }])]) await assert.rejects(write(), refused);
    await assert.rejects(Client.create({ workspaceId: WS, name: "another" }), refused);
    await assert.rejects(WorkspaceMember.updateOne({ workspaceId: WS, userId: USER }, { $set: { role: "member" } }), refused);
    const caller = clientsRouter.createCaller({ user: { id: USER }, session: { user: { id: USER } }, activeWorkspaceId: WS } as unknown as Context);
    await assert.rejects(caller.list({}), refused);
    assert.equal((await Client.findById(row._id).lean())!.name, "original"); assert.equal(await Client.countDocuments(), 1);
  });
  it("keeps standard workspaces usable and pins a broad single-row update to its fenced workspace", async () => {
    const first = await Client.create({ workspaceId: WS, name: "same" }), second = await Client.create({ workspaceId: OTHER, name: "same" }); await freeze(WS, "encrypted");
    await assert.rejects(Client.findOneAndUpdate({ name: "same" }, { $set: { name: "blocked" } }, { sort: { workspaceId: 1 } }), refused);
    const result = await Client.findOneAndUpdate({ name: "same" }, { $set: { name: "standard changed" } }, { sort: { workspaceId: -1 }, returnDocument: "after" });
    assert.equal(String(result!._id), String(second._id)); assert.equal((await Client.findById(first._id).lean())!.name, "same");
    await Client.create({ workspaceId: OTHER, name: "still standard" });
  });
  it("retries a writer with an old snapshot after migration takes the fence, then refuses it", async () => {
    const row = await Client.create({ workspaceId: WS, name: "original" });
    let ready!: () => void, release!: () => void, attempts = 0;
    const snapshotReady = new Promise<void>((resolve) => { ready = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const writer = withBusinessTransaction(async () => {
      attempts++; await Client.findById(row._id).lean();
      if (attempts === 1) { ready(); await released; }
      return Client.updateOne({ _id: row._id }, { $set: { name: "stale write" } });
    });
    await snapshotReady; await freeze(); release(); await assert.rejects(writer, refused);
    assert.ok(attempts >= 2); assert.equal((await Client.findById(row._id).lean())!.name, "original");
  });
  it("limits the trusted account-erasure exception to its selected workspaces", async () => {
    await Client.create([{ workspaceId: WS, name: "erase" }, { workspaceId: OTHER, name: "keep" }]); await freeze(); await freeze(OTHER);
    await assert.rejects(withPrivateWorkspaceErasure([WS], () => Client.deleteMany({ workspaceId: OTHER }).then((value) => value)), refused);
    assert.equal(await mongooseRowStore.deleteMany("clients", { workspaceId: WS }), 1);
    assert.equal(await Client.countDocuments({ workspaceId: OTHER }), 1);
  });
  it("fences stored webhook envelopes and skips private workspaces when claiming due deliveries", async () => {
    const privateRow = await WebhookDelivery.create(delivery(WS)), standardRow = await WebhookDelivery.create(delivery(OTHER)); await freeze();
    await assert.rejects(WebhookDelivery.insertMany([delivery(WS)]), refused);
    await assert.rejects(WebhookDelivery.updateOne({ _id: privateRow._id }, { $set: { status: "sent" } }), refused);
    await assert.rejects(WebhookDelivery.deleteMany({ workspaceId: WS }), refused);
    const claimed = await claimDueDeliveries(new Date(), 1);
    assert.deepEqual(claimed, [String(standardRow._id)]);
    assert.equal((await WebhookDelivery.findById(privateRow._id).lean())!.nextAttemptAt!.getTime(), 0);
    await assert.rejects(WebhookDelivery.updateOne({ _id: standardRow._id }, { $set: { workspaceId: WS } }), { code: "BAD_REQUEST" });
  });
  it("answers valid legacy REST credentials with a retryable 412 instead of exposing plaintext", async () => {
    const minted = mintApiToken();
    await ApiToken.create({ workspaceId: WS, userId: USER, name: "test", prefix: minted.prefix, tokenHash: minted.tokenHash, scopes: ["entries:read"] }); await freeze();
    const error = await new Promise<unknown>((resolve) => {
      let status = 200;
      const response = { status(value: number) { status = value; return this; }, type() { return this; }, send(body: unknown) { resolve({ status, body }); return this; }, setHeader() { return this; } };
      requireApiToken({ headers: { authorization: `Bearer ${minted.plaintext}` }, ip: "127.0.0.1", originalUrl: "/api/v1/entries", body: {}, query: {} } as unknown as Request, response as unknown as Response, (failure) => resolve(failure));
    });
    assert.ok(error instanceof TRPCError); assert.equal(error.message, PRIVATE_WORKSPACE_REQUIRED);
    const problem = problemFromTRPCError(error, "/api/v1/entries"); assert.equal(problem.status, 412); assert.ok(problem.type.endsWith("/encrypted-workspace"));
  });
});
