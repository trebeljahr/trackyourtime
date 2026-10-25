import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { createKeyPair, createSigningPair, createPrivatePreparationRequest, createPrivateOriginalStageRequest, createPrivateProjectionOwnerProof, createPrivateProjectionPersonalProof, deriveRecoveryBackupKey, encryptCombinedRecoveryKeyBackup, encodeSecret, randomSecret, canonicalJson, decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, partitionPrivateRecoverySupplement, privateInitialSnapshotProjection, privateMemberKeyFingerprint, privateSourceSessionBinding, signPrivateChange, signPrivateInitialProjectionRoot, signPrivateWorkspaceDirectory, verifyPrivateInitialProjection, verifyPrivateWorkspaceDirectory, type PlainPrivateRecord, type PublicKey, type VerifiedPrivateDirectory } from "@starter/core";
import { canWritePrivateRecord, type PrivateDirectoryMember, type SignedPrivatePreparationRequest, type SignedPrivateProjectionOwnerProof, type SignedPrivateProjectionPersonalProof } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivatePreparationRequest, PrivateProjectionReader, PrivateProjectionRoot, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateSourceChallengeRequest, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { env } from "../config/env.js";
import { beginPrivateClientPreparation } from "../services/privacy/begin-preparation.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { workspaceRecovery } from "../services/privacy/recovery.js";
import { capturePrivateMigrationSupplement } from "../services/privacy/recovery-supplement.js";
import { combinedWorkspaceRecovery } from "../services/privacy/combined-recovery.js";
import { discardPrivatePreparation } from "../services/privacy/preparation.js";
import { authorizePrivateOriginalStage } from "../services/privacy/original-staging.js";
import { captureCompleteProjectionPreparation, privateProjectionProposal } from "../services/privacy/projection-proposal.js";
import { preparePrivateProjectionSnapshot } from "../services/privacy/projection-snapshots.js";
import { privateProjectionPreparationReadiness, recordPrivateProjectionOwnerProof, recordPrivateProjectionPersonalProof } from "../services/privacy/projection-receipts.js";
import { personalMigrationSource } from "../services/privacy/personal-migration.js";
import { stagePrivateMigrationBatch, runVerifiedPrivateOriginalStage } from "../services/privacy/migration.js";
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
    await db.collection("timeentries").insertOne({ workspaceId: scope.workspaceId, authorId: "member", description: "Member read-only original", start: new Date("2026-10-24T00:00:00.000Z"), end: new Date("2026-10-24T01:00:00.000Z"), hourlyRate: 120, invoiceId: "issued-original" });
    await db.collection<{ _id: string; workspaceId: string; createdBy: string; xml: string }>("invoices").insertOne({ _id: "issued-original", workspaceId: scope.workspaceId, createdBy: "owner", xml: "<Invoice>Original linked peer work</Invoice>" });
    await db.collection("favorites").insertMany([ { workspaceId: scope.workspaceId, userId: "owner", description: "Owner original pin" }, { workspaceId: scope.workspaceId, userId: "member", description: "Member original pin" } ]);
    await db.collection("webhooksubscriptions").insertMany([ { workspaceId: scope.workspaceId, createdBy: "owner", secret: "Owner original secret" }, { workspaceId: scope.workspaceId, createdBy: "member", secret: "Member original secret" } ]);
  });
  after(dropTestDatabase);
  const begin = (proof: SignedPrivatePreparationRequest) => beginPrivateClientPreparation(scope, proof);
  async function staging(extraTags = 0) {
    if (extraTags) await mongoose.connection.db!.collection("tags").insertMany(Array.from({ length: extraTags }, (_, index) => ({ workspaceId: scope.workspaceId, name: `Original extra tag ${index}` })));
    const proof = await request(); await begin(proof);
    const signed = await createPrivateOriginalStageRequest({ directory, userId: scope.userId, sessionId: scope.sessionId, migrationId: proof.request.migrationId, secrets: owner, current: () => true });
    return { proof, signed, workerScope: { ...scope, migrationId: proof.request.migrationId } };
  }
  const gate = () => {
    let enter!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
    const encrypt: typeof encryptPrivateRecord = async (...args) => { enter(); await wait; return encryptPrivateRecord(...args); };
    return { ready, release, encrypt };
  };
  async function contentVerification() {
    const f = await staging(); await authorizePrivateOriginalStage(scope, f.signed);
    await runVerifiedPrivateOriginalStage(f.workerScope);
    const proposal = await privateProjectionProposal(f.workerScope);
    const signed = await signPrivateInitialProjectionRoot({ ...proposal, personalDigests: new Map(proposal.personalDigests.map((row) => [row.userId, row.digest])), directory, userId: "owner", secrets: owner, current: () => true });
    const { root } = await preparePrivateProjectionSnapshot(f.workerScope, signed);
    const captured = await captureCompleteProjectionPreparation(f.workerScope);
    function proof(userId: "owner"): Promise<SignedPrivateProjectionOwnerProof>;
    function proof(userId: "member"): Promise<SignedPrivateProjectionPersonalProof>;
    async function proof(userId: "member" | "owner") {
      const secrets = userId === "owner" ? owner : member, ownScope = { ...scope, userId };
      const projected = privateInitialSnapshotProjection(captured.records, userId);
      const snapshot = await verifyPrivateInitialProjection({ signed, sharedRecords: projected.filter((row) => !["favorites", "integrations"].includes(row.kind)), personalRecords: projected.filter((row) => ["favorites", "integrations"].includes(row.kind)), scope: ownScope, directory, secrets, current: () => true });
      const archive = userId === "owner" ? await combinedWorkspaceRecovery(scope.workspaceId, userId, scope.server) : await personalMigrationSource({ ...ownScope, migrationId: f.workerScope.migrationId });
      const backupKey = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), ownScope);
      try {
        const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, backupKey, () => true));
        const options = { readBackup: async () => raw, backupKey, snapshot, directory, userId, secrets, current: () => true };
        return userId === "owner" ? await createPrivateProjectionOwnerProof(options) : await createPrivateProjectionPersonalProof(options);
      } finally { backupKey.fill(0); }
    }
    return { ...f, root, proof, readiness: () => privateProjectionPreparationReadiness(f.workerScope, root) };
  }
  it("requires current saved-file owner and opaque-personal verification without revealing missing members", async () => {
    const f = await contentVerification();
    assert.deepEqual(await f.readiness(), { status: "awaiting-verification" });
    await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
    assert.deepEqual(await f.readiness(), { status: "awaiting-verification" });
    await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
    for (let retry = 0; retry < 2; retry++) assert.deepEqual(await f.readiness(), { status: "content-verified" });
    const mode = (await PrivateWorkspace.findOne().lean())!;
    assert.equal(mode.state, "migrating"); assert.equal(mode.backupVerified, false); assert.equal(mode.head, null);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("does not demand a personal-data receipt from a member with no private originals", async () => {
    await mongoose.connection.db!.collection("favorites").deleteMany({ userId: "member" });
    await mongoose.connection.db!.collection("webhooksubscriptions").deleteMany({ createdBy: "member" });
    const f = await contentVerification();
    await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
    assert.deepEqual(await f.readiness(), { status: "content-verified" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 1);
  });
  it("revalidates saved receipt signatures and source bindings instead of trusting row presence", async () => {
    const f = await contentVerification();
    const ownerProof = await f.proof("owner"), personalProof = await f.proof("member");
    await recordPrivateProjectionOwnerProof(scope, ownerProof);
    await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, personalProof);
    await PrivateMigrationReceipt.updateOne({ kind: "personal" }, { $set: { signature: await signPrivateChange(owner.signingPrivateKey, personalProof.proof) } });
    await assert.rejects(f.readiness(), { code: "FORBIDDEN" });
    await PrivateMigrationReceipt.updateOne({ kind: "personal" }, { $set: { signature: personalProof.signature, "proof.sourceRevision": "a".repeat(64) } });
    const changed = { ...personalProof.proof, sourceRevision: "a".repeat(64) };
    await PrivateMigrationReceipt.updateOne({ kind: "personal" }, { $set: { signature: await signPrivateChange(member.signingPrivateKey, changed) } });
    await assert.rejects(f.readiness(), { code: "CONFLICT" });
    await PrivateMigrationReceipt.updateOne({ kind: "personal" }, { $set: { proof: { ...personalProof.proof, v: 1 }, signature: personalProof.signature } });
    await assert.rejects(f.readiness());
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
  });
  it("refuses stale roots, unfinished original conversion and inconsistent worker progress", async () => {
    const f = await contentVerification();
    await assert.rejects(privateProjectionPreparationReadiness(f.workerScope, "bad"), { code: "BAD_REQUEST" });
    await assert.rejects(privateProjectionPreparationReadiness(f.workerScope, "A".repeat(43)), { code: "CONFLICT" });
    await PrivateWorkspace.updateOne({}, { $set: { "originalStage.complete": false } });
    await assert.rejects(f.readiness(), /Original conversion is incomplete/);
    await PrivateWorkspace.updateOne({}, { $set: { "originalStage.complete": true, "originalStage.cursor": 0 } });
    await assert.rejects(f.readiness(), { code: "CONFLICT" });
    await PrivateWorkspace.updateOne({}, { $set: { preparationProtocol: "legacy" } });
    await assert.rejects(f.readiness(), { code: "NOT_FOUND" });
  });
  it("rechecks complete originals, frozen storage, current keys and lease on readiness polling", async () => {
    const f = await contentVerification();
    await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
    await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
    const original = (await PrivateAccount.findOne({ userId: "member" }).lean())!.identity.signingPublicKey;
    await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.signingPublicKey": (await createSigningPair()).publicKey } });
    await assert.rejects(f.readiness(), /account keys changed/);
    await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.signingPublicKey": original } });
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "changed private original" } });
    await assert.rejects(f.readiness(), /Original data changed/);
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Member original secret" } });
    await PrivateProjectionReader.deleteOne({ userId: "member" });
    await assert.rejects(f.readiness(), /incomplete/);
    await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assert.rejects(f.readiness(), { code: "PRECONDITION_FAILED" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 2);
  });
  it("converts only exact frozen originals in bounded batches and atomically stores resumable progress", async () => {
    const f = await staging(60);
    assert.equal(canWritePrivateRecord("entries", "member", directory.signed.directory.members.find((person) => person.userId === "owner")!), false);
    assert.deepEqual(await authorizePrivateOriginalStage(scope, f.signed), { status: "queued" });
    assert.deepEqual(await authorizePrivateOriginalStage(scope, f.signed), { status: "working" });
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "working" });
    assert.equal(await PrivateRecord.countDocuments(), 50);
    const firstRows = await PrivateRecord.find().sort({ id: 1 }).lean(), first = canonicalJson(firstRows);
    assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage!.cursor, 50);
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "complete" });
    assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage!.complete, true);
    const captured = await captureCompleteProjectionPreparation(f.workerScope), plain: PlainPrivateRecord[] = [];
    for (const row of captured.records) {
      const reader = row.grants.some((grant) => grant.userId === "owner") ? "owner" : "member";
      plain.push(await decryptPrivateRecord(scope.workspaceId, row, reader, (reader === "owner" ? owner : member).privateKey));
    }
    // The conversion worker takes no replacement values. Every original BSON
    // value and author binding survives exactly, including opaque peer data.
    const original = [...partitionPrivateRecovery(await workspaceRecovery(scope.workspaceId, "owner", true)), ...partitionPrivateRecoverySupplement(await capturePrivateMigrationSupplement(scope.workspaceId, "owner"))];
    const ordered = (rows: typeof plain) => rows.sort((a, b) => JSON.stringify([a.kind, a.id]) < JSON.stringify([b.kind, b.id]) ? -1 : 1);
    assert.equal(canonicalJson(ordered(plain)), canonicalJson(ordered(original)));
    const ids = firstRows.map((row) => row._id);
    assert.equal(canonicalJson(await PrivateRecord.find({ _id: { $in: ids } }).sort({ id: 1 }).lean()), first);
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "complete" });
    const proposal = await privateProjectionProposal(f.workerScope);
    for (const row of captured.records.filter((row) => ["favorites", "integrations"].includes(row.kind) && row.authorId === "member")) assert.equal(JSON.stringify(proposal).includes(row.id), false);
    const mode = (await PrivateWorkspace.findOne().lean())!; assert.equal(mode.state, "migrating"); assert.equal(mode.backupVerified, false); assert.equal(mode.head, null);
  });
  it("rejects forged/replayed-scope job requests, missing authorization and replacement-content fields", async () => {
    const f = await staging();
    await assert.rejects(runVerifiedPrivateOriginalStage(f.workerScope), { code: "NOT_FOUND" });
    const forged = structuredClone(f.signed); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.request);
    await assert.rejects(authorizePrivateOriginalStage(scope, forged), { code: "FORBIDDEN" });
    await assert.rejects(authorizePrivateOriginalStage({ ...scope, sessionId: "different-session" }, f.signed), { code: "NOT_FOUND" });
    await assert.rejects(authorizePrivateOriginalStage(scope, { ...f.signed, records: [] } as never));
    assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage, null); assert.equal(await PrivateRecord.countDocuments(), 0);
  });
  it("keeps concurrent worker retries on the first accepted ciphertext and never skips a cursor", async () => {
    const f = await staging(60); await authorizePrivateOriginalStage(scope, f.signed);
    const hold = gate(), first = runVerifiedPrivateOriginalStage(f.workerScope, hold.encrypt); await hold.ready;
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "working" });
    const saved = canonicalJson(await PrivateRecord.find().sort({ id: 1 }).lean()); hold.release(); await first;
    assert.equal(await PrivateRecord.countDocuments(), 50); assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage!.cursor, 50);
    assert.equal(canonicalJson(await PrivateRecord.find().sort({ id: 1 }).lean()), saved);
  });
  it("rolls ciphertext back with a failed cursor acknowledgement and safely resumes the job", async () => {
    const f = await staging(60); await authorizePrivateOriginalStage(scope, f.signed);
    const failure = mock.method(PrivateWorkspace, "updateOne", async () => { throw new Error("Injected cursor acknowledgement failure"); });
    try { await assert.rejects(runVerifiedPrivateOriginalStage(f.workerScope), /Injected cursor/); } finally { failure.mock.restore(); }
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage!.cursor, 0);
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "working" });
  });
  it("cannot publish a late batch after cancellation or a changed member signing key", async () => {
    const f = await staging(60); await authorizePrivateOriginalStage(scope, f.signed);
    const hold = gate(), pending = runVerifiedPrivateOriginalStage(f.workerScope, hold.encrypt); await hold.ready;
    await discardPrivatePreparation(scope.workspaceId, f.workerScope.migrationId); hold.release();
    await assert.rejects(pending, { code: "NOT_FOUND" }); assert.equal(await PrivateRecord.countDocuments(), 0);
    await assert.rejects(authorizePrivateOriginalStage(scope, f.signed), { code: "NOT_FOUND" });
    const fresh = await staging(); await authorizePrivateOriginalStage(scope, fresh.signed);
    const next = gate(), stale = runVerifiedPrivateOriginalStage(fresh.workerScope, next.encrypt); await next.ready;
    await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.signingPublicKey": (await createSigningPair()).publicKey } }); next.release();
    await assert.rejects(stale, /account keys changed/); assert.equal(await PrivateRecord.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.originalStage!.cursor, 0);
  });
  it("refuses expired leases and changed original data even after the worker reports complete", async () => {
    const f = await staging(); await authorizePrivateOriginalStage(scope, f.signed);
    assert.deepEqual(await runVerifiedPrivateOriginalStage(f.workerScope), { status: "complete" });
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed peer original" } });
    await assert.rejects(runVerifiedPrivateOriginalStage(f.workerScope), /Original data changed/);
    await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assert.rejects(runVerifiedPrivateOriginalStage(f.workerScope), { code: "PRECONDITION_FAILED" });
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("preflights before leasing, pins the complete source internally and keeps concurrent retries idempotent", async () => {
    const proof = await request(), [first, second] = await Promise.all([begin(proof), begin(proof)]);
    assert.deepEqual(first, second); assert.equal(first.migrationId, proof.request.migrationId);
    assert.doesNotMatch(JSON.stringify(first), /sourceRevision|supplementRevision|Member original|Owner original/);
    assert.equal(await PrivatePreparationRequest.countDocuments(), 1); assert.equal(await PrivateWorkspace.countDocuments(), 1);
    const mode = (await PrivateWorkspace.findOne().lean())!;
    assert.equal(mode.preparationProtocol, "client-v2"); assert.equal(mode.directoryDigest, directory.digest);
    assert.equal(mode.backupVerified, false); assert.equal(mode.revision, 0); assert.equal(mode.head, null);
    assert.equal(await PrivateRecord.countDocuments(), 0); assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
    await assert.rejects(stagePrivateMigrationBatch(scope.workspaceId, "owner", mode.migrationId, 0), /signed original-conversion authorization/);
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
    await mongoose.connection.db!.collection("timeentries").deleteMany({ description: "Running original" });
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
