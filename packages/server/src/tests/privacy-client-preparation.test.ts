import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { createKeyPair, createSigningPair, createPrivatePreparationRequest, privateMemberKeyFingerprint, privateSourceSessionBinding, signPrivateChange, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, type PublicKey, type VerifiedPrivateDirectory } from "@starter/core";
import type { PrivateDirectoryMember, SignedPrivatePreparationRequest } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivatePreparationRequest, PrivateProjectionReader, PrivateProjectionRoot, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateSourceChallengeRequest, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { env } from "../config/env.js";
import { beginPrivateClientPreparation } from "../services/privacy/begin-preparation.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { combinedWorkspaceRecovery } from "../services/privacy/combined-recovery.js";
import { discardPrivatePreparation } from "../services/privacy/preparation.js";
import { stagePrivateMigrationBatch } from "../services/privacy/migration.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { auditPrivateWorkspaceRetirement } from "../services/privacy/retirement-audit.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner", sessionId: "current-session" };
let owner: { privateKey: PublicKey; signingPrivateKey: PublicKey }, member: typeof owner, directory: VerifiedPrivateDirectory;
async function request(now?: number) {
  return createPrivatePreparationRequest({ archive: await combinedWorkspaceRecovery(scope.workspaceId, scope.userId, scope.server), directory, userId: scope.userId, sessionId: scope.sessionId, migrationId: crypto.randomUUID(), secrets: owner, current: () => true, now });
}
describe("signed client preparation lease", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-client-preparation", [PrivateAccount, PrivateDirectory, PrivatePreparationRequest, PrivateWorkspace, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateProjectionRoot, PrivateProjectionReader, PrivateMigrationReceipt, PrivateWorkspaceCommit, PrivateSourceChallengeRequest, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase(); const people: PrivateDirectoryMember[] = [];
    for (const userId of ["member", "owner"]) {
      const keys = await createKeyPair(), signing = await createSigningPair(), secrets = { privateKey: keys.privateKey, signingPrivateKey: signing.privateKey };
      if (userId === "owner") owner = secrets; else member = secrets;
      people.push({ userId, role: userId === "owner" ? "owner" : "member", canViewOthersTime: userId === "owner", canViewOthersMoney: userId === "owner", publicKey: keys.publicKey, signingPublicKey: signing.publicKey });
      await WorkspaceMember.create({ workspaceId: scope.workspaceId, userId, role: userId === "owner" ? "owner" : "member", name: userId });
      await PrivateAccount.create({ userId, identity: { publicKey: keys.publicKey, signingPublicKey: signing.publicKey, recovery: {}, passkeys: [] } });
    }
    const fingerprints = new Map(await Promise.all(people.map(async (person) => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const)));
    const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: people }, owner.signingPrivateKey, null, fingerprints);
    await commitPrivateDirectory(scope, signed);
    directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: people[1]!.signingPublicKey, revision: 0, digest: null });
    const db = mongoose.connection.db!;
    await db.collection<{ _id: string; kind: string; name: string }>("organization").insertOne({ _id: scope.workspaceId, kind: "team", name: "Original workspace" });
    await db.collection("tags").insertOne({ workspaceId: scope.workspaceId, name: "Original shared tag" });
    await db.collection("favorites").insertMany([ { workspaceId: scope.workspaceId, userId: "owner", description: "Owner original pin" }, { workspaceId: scope.workspaceId, userId: "member", description: "Member original pin" } ]);
    await db.collection("webhooksubscriptions").insertMany([ { workspaceId: scope.workspaceId, createdBy: "owner", secret: "Owner original secret" }, { workspaceId: scope.workspaceId, createdBy: "member", secret: "Member original secret" } ]);
  });
  after(dropTestDatabase);
  const begin = (proof: SignedPrivatePreparationRequest) => beginPrivateClientPreparation(scope, proof);
  it("preflights before leasing, pins the complete source internally and keeps concurrent retries idempotent", async () => {
    const proof = await request(), [first, second] = await Promise.all([begin(proof), begin(proof)]);
    assert.deepEqual(first, second); assert.equal(first.migrationId, proof.request.migrationId);
    assert.doesNotMatch(JSON.stringify(first), /sourceRevision|supplementRevision|Member original|Owner original/);
    assert.equal(await PrivatePreparationRequest.countDocuments(), 1); assert.equal(await PrivateWorkspace.countDocuments(), 1);
    const mode = (await PrivateWorkspace.findOne().lean())!;
    assert.equal(mode.preparationProtocol, "client-v2"); assert.equal(mode.directoryDigest, directory.digest);
    assert.equal(mode.backupVerified, false); assert.equal(mode.revision, 0); assert.equal(mode.head, null);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
    await assert.rejects(stagePrivateMigrationBatch(scope.workspaceId, "owner", mode.migrationId, 0), /signed client staging/);
  });
  it("keeps the consumed request after cancellation so a late retry cannot recreate its lease", async () => {
    const proof = await request(); await begin(proof);
    await discardPrivatePreparation(scope.workspaceId, proof.request.migrationId);
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivatePreparationRequest.countDocuments(), 1);
    await assert.rejects(begin(proof), /canceled or this request was already used/);
    assert.equal(await PrivateWorkspace.countDocuments(), 0);
    const fresh = await request(); await begin(fresh); assert.equal(await PrivatePreparationRequest.countDocuments(), 2);
  });
  it("refuses insufficient temporary headroom before a nonce or lease is committed", async () => {
    const proof = await request(), previous = env.STORAGE_QUOTA_BYTES;
    try {
      Object.defineProperty(env, "STORAGE_QUOTA_BYTES", { value: 64 * 1024 });
      await assert.rejects(begin(proof), /Storage limit reached/);
    } finally { Object.defineProperty(env, "STORAGE_QUOTA_BYTES", { value: previous }); }
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivatePreparationRequest.countDocuments(), 0);
    assert.equal(await mongoose.connection.db!.collection("tags").countDocuments(), 1);
  });
  it("rejects forged, cross-session, wrong-scope and expired authorization before creating state", async () => {
    const proof = await request(), forged = structuredClone(proof); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.request);
    await assert.rejects(begin(forged), { code: "FORBIDDEN" });
    await assert.rejects(beginPrivateClientPreparation({ ...scope, sessionId: "different-session" }, proof), { code: "NOT_FOUND" });
    await assert.rejects(beginPrivateClientPreparation({ ...scope, workspaceId: "elsewhere" }, proof), { code: "NOT_FOUND" });
    const wrong = structuredClone(proof); wrong.request.userId = "member"; wrong.request.sessionBinding = await privateSourceSessionBinding({ ...scope, userId: "member" }); wrong.signature = await signPrivateChange(member.signingPrivateKey, wrong.request);
    await assert.rejects(beginPrivateClientPreparation({ ...scope, userId: "member" }, wrong), { code: "FORBIDDEN" });
    await assert.rejects(begin(await request(Date.now() - 121_000)), /authorization expired/);
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivatePreparationRequest.countDocuments(), 0);
  });
  it("rechecks complete peer originals and current directory signature/keys even on identical retry", async () => {
    const proof = await request(); await begin(proof);
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed peer secret" } });
    await assert.rejects(begin(proof), /Original data changed/);
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Member original secret" } });
    const signing = await createSigningPair(); await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.signingPublicKey": signing.publicKey } });
    await assert.rejects(begin(proof), /account keys changed/);
    assert.equal(await PrivateWorkspace.countDocuments(), 1); assert.equal(await PrivatePreparationRequest.countDocuments(), 1);
  });
  it("refuses active timers, changed originals, corrupt directory history and orphaned private work", async () => {
    const proof = await request();
    await mongoose.connection.db!.collection("timeentries").insertOne({ workspaceId: scope.workspaceId, authorId: "owner", end: null, description: "Running original" });
    await assert.rejects(begin(proof), /Original data changed/);
    await assert.rejects(begin(await request()), /Stop all workspace timers/);
    await mongoose.connection.db!.collection("timeentries").deleteMany({});
    await PrivateRecord.collection.insertOne({ workspaceId: scope.workspaceId, id: "orphan", kind: "tags" } as never);
    await assert.rejects(begin(proof), /Existing private work/); await PrivateRecord.collection.deleteMany({});
    await PrivateDirectory.updateOne({}, { $set: { "signed.signature": "A".repeat(86) } });
    await assert.rejects(begin(proof), /key directory needs verification/);
    assert.equal(await PrivateWorkspace.countDocuments(), 0); assert.equal(await PrivatePreparationRequest.countDocuments(), 0);
  });
  it("bounds canceled live authorizations, flags their source commitments for retirement and erases account metadata", async () => {
    for (let index = 0; index < 3; index++) { const proof = await request(); await begin(proof); await discardPrivatePreparation(scope.workspaceId, proof.request.migrationId); }
    await assert.rejects(begin(await request()), { code: "TOO_MANY_REQUESTS" }); assert.equal(await PrivateWorkspace.countDocuments(), 0);
    assert.ok((await auditPrivateWorkspaceRetirement(mongoose.connection.db!, scope.workspaceId)).leaks.some((leak) => leak.collection === "privatepreparationrequests" && leak.reason === "source-checksums" && leak.records === 3));
    await mongooseRowStore.deleteMany("privatePreparationRequests", { userId: "owner" }); assert.equal(await PrivatePreparationRequest.countDocuments(), 0);
  });
});
