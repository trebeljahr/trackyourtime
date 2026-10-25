import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { ObjectId, Long } from "mongodb";
import { decryptCombinedRecoveryKeyBackup, deriveRecoveryBackupKey, encodeSecret, encryptCombinedRecoveryKeyBackup, partitionPrivateRecovery, partitionPrivateRecoverySupplement, privateRecordsToRecovery, privateRecordsToRecoverySupplement, randomSecret, recoveryDigest } from "@starter/core";
import { combinedWorkspaceRecovery } from "../services/privacy/combined-recovery.js";
import { verifyCombinedRecoveryCopy } from "../services/privacy/restore-combined-copy.js";
import { PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", ownerId: "owner" };
const db = () => mongoose.connection.db!;
describe("combined original recovery and BSON order", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-combined-recovery", [WorkspaceMember, PrivateWorkspace, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create({ workspaceId: scope.workspaceId, userId: "owner", role: "owner", name: "Owner" });
    const ids = [new ObjectId("000000000000000000000002"), "\u{10000}", "\ue000", "z"];
    for (const _id of ids) {
      await db().collection<{ _id: string | ObjectId } & Record<string, unknown>>("clients").insertOne({ _id, workspaceId: scope.workspaceId, name: "Original client", billing: { integer: Long.fromString("9007199254740993") } });
      await db().collection<{ _id: string | ObjectId } & Record<string, unknown>>("apitokens").insertOne({ _id, workspaceId: scope.workspaceId, userId: "owner", name: "Original private label" });
    }
    await db().collection<{ _id: string } & Record<string, unknown>>("organization").insertOne({ _id: scope.workspaceId, name: "Original organization", slug: "original-organization" });
    await db().collection("webhooksubscriptions").insertMany([{ workspaceId: scope.workspaceId, createdBy: "owner", url: "https://private.example.test/hook", secret: "Owner original signing secret" }, { workspaceId: scope.workspaceId, createdBy: "member", secret: "Other creator private signing secret" }]);
    await db().collection("invoices").insertOne({ workspaceId: scope.workspaceId, createdBy: "owner", xml: '<Invoice id="original">€ — exact issued XML</Invoice>' });
  });
  after(dropTestDatabase);
  it("reconstructs both exact source checksums with mixed string/ObjectId and UTF-8 string ordering", async () => {
    const archive = await combinedWorkspaceRecovery(scope.workspaceId, scope.ownerId, scope.server);
    assert.deepEqual(archive.snapshot.collections.clients.map((row) => row._id), ["z", "\ue000", "\u{10000}", { $oid: "000000000000000000000002" }]);
    assert.deepEqual(await privateRecordsToRecovery(scope.workspaceId, partitionPrivateRecovery(archive.snapshot), archive.snapshot.createdAt), archive.snapshot);
    assert.deepEqual(await privateRecordsToRecoverySupplement(scope.workspaceId, partitionPrivateRecoverySupplement(archive.supplement), archive.supplement.createdAt), archive.supplement);
    assert.doesNotMatch(JSON.stringify(archive), /Other creator private signing secret/);
  });
  it("decrypts a combined original file and restores all seventeen collections into one isolated database without touching source", async () => {
    const archive = await combinedWorkspaceRecovery(scope.workspaceId, scope.ownerId, scope.server), secret = encodeSecret(randomSecret());
    const key = await deriveRecoveryBackupKey(secret, { server: scope.server, userId: scope.ownerId });
    const file = await encryptCombinedRecoveryKeyBackup(archive, key, () => true); key.fill(0);
    const reopened = await decryptCombinedRecoveryKeyBackup(JSON.parse(JSON.stringify(file)), secret);
    const result = await verifyCombinedRecoveryCopy(mongoose.connection.getClient(), reopened);
    assert.equal(Object.keys(result.counts).length, 17);
    assert.equal(result.counts.clients, 4); assert.equal(result.counts.apitokens, 4); assert.equal(result.counts.webhooksubscriptions, 1);
    assert.equal(result.sourceRevision, archive.snapshot.sourceRevision); assert.equal(result.supplementRevision, archive.supplement.sourceRevision);
    const after = await combinedWorkspaceRecovery(scope.workspaceId, scope.ownerId, scope.server);
    assert.equal(after.snapshot.sourceRevision, archive.snapshot.sourceRevision); assert.equal(after.supplement.sourceRevision, archive.supplement.sourceRevision);
    assert.equal(await db().collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("rejects a noncanonical typed restore and removes its failed isolated copy", async () => {
    const archive = await combinedWorkspaceRecovery(scope.workspaceId, scope.ownerId, scope.server);
    archive.snapshot.collections.timeentries.push({ _id: "noncanonical", workspaceId: scope.workspaceId, value: { $numberDouble: "1.00" } });
    archive.snapshot.sourceRevision = await recoveryDigest(archive.snapshot.collections);
    const client = mongoose.connection.getClient();
    const copies = async () => (await client.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((row) => row.name).filter((name) => name.startsWith("trackyourtime-recovery-check-"));
    const before = await copies();
    await assert.rejects(verifyCombinedRecoveryCopy(client, archive), /differs from/);
    assert.deepEqual(await copies(), before);
    assert.equal(await db().collection("timeentries").countDocuments(), 0);
  });
});
