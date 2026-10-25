import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { Long } from "mongodb";
import { createKeyPair, createSigningPair, createPrivateFavoritesMigrationProof, createPrivateOwnerMigrationProof, createPrivateCombinedOwnerMigrationProof, createPrivatePersonalMigrationProof, createPrivateProjectionOwnerProof, createPrivateProjectionPersonalProof, signPrivateInitialProjectionRoot, verifyPrivateInitialProjection, encryptCombinedRecoveryKeyBackup, deriveRecoveryBackupKey, encryptRecoveryKeyBackup, encodeSecret, encryptPrivateRecord, partitionPrivateRecovery, privateRecordDigest, privateMemberKeyFingerprint, privateInitialSnapshotProjection, randomSecret, seal, signPrivateChange, signPrivateInitialSnapshot, signPrivateWorkspaceDirectory, verifyPrivateInitialSnapshot, verifyPrivateWorkspaceDirectory, type PublicKey, type VerifiedPrivateDirectory } from "@starter/core";
import type { PrivateDirectoryMember, SignedPrivateFavoritesMigrationProof, SignedPrivateOwnerMigrationProof } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateProjectionRoot, PrivateProjectionReader, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { migrationFavoritesSource, workspaceRecovery } from "../services/privacy/recovery.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { preparePrivateInitialSnapshot } from "../services/privacy/initial-snapshots.js";
import { recordPrivateFavoritesMigrationProof, recordPrivateOwnerMigrationProof, recordPrivateCombinedOwnerMigrationProof } from "../services/privacy/migration-receipts.js";
import { personalMigrationSource, recordPrivatePersonalMigrationProof } from "../services/privacy/personal-migration.js";
import { preparePrivateProjectionSnapshot, privateProjectionSnapshotRoot, privateProjectionSnapshotPage } from "../services/privacy/projection-snapshots.js";
import { recordPrivateProjectionOwnerProof, recordPrivateProjectionPersonalProof } from "../services/privacy/projection-receipts.js";
import { discardPrivatePreparation } from "../services/privacy/preparation.js";
import { privateProjectionProposal } from "../services/privacy/projection-proposal.js";
import { combinedWorkspaceRecovery } from "../services/privacy/combined-recovery.js";
import { capturePrivateMigrationSupplement } from "../services/privacy/recovery-supplement.js";
import { stagePrivateMigrationBatch } from "../services/privacy/migration.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "member" };
let ownerProof: SignedPrivateOwnerMigrationProof;
let migrationId: string, directory: VerifiedPrivateDirectory, people: PrivateDirectoryMember[], proof: SignedPrivateFavoritesMigrationProof;
let owner: { privateKey: PublicKey; signingPrivateKey: PublicKey }, member: typeof owner;
describe("private preferences conversion receipts", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-migration-receipts", [PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateProjectionRoot, PrivateProjectionReader, PrivateWorkspace, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase(); migrationId = crypto.randomUUID();
    const ownerPair = await createKeyPair(), ownerSigning = await createSigningPair(), memberPair = await createKeyPair(), memberSigning = await createSigningPair();
    owner = { privateKey: ownerPair.privateKey, signingPrivateKey: ownerSigning.privateKey }; member = { privateKey: memberPair.privateKey, signingPrivateKey: memberSigning.privateKey };
    people = [
      { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: memberPair.publicKey, signingPublicKey: memberSigning.publicKey },
      { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: ownerPair.publicKey, signingPublicKey: ownerSigning.publicKey },
    ];
    for (const p of people) {
      await WorkspaceMember.create({ workspaceId: scope.workspaceId, ...p, name: p.userId });
      await PrivateAccount.create({ userId: p.userId, identity: { publicKey: p.publicKey, signingPublicKey: p.signingPublicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
    }
    const confirmed = new Map(await Promise.all(people.map(async (p) => [p.userId, await privateMemberKeyFingerprint(scope.server, p)] as const)));
    const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: people }, owner.signingPrivateKey, null, confirmed);
    await commitPrivateDirectory({ ...scope, userId: "owner" }, signedDirectory);
    directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: "owner", signingPublicKey: ownerSigning.publicKey, revision: 0, digest: null });
    const db = mongoose.connection.db!;
    await db.collection("favorites").insertMany([
      { workspaceId: scope.workspaceId, userId: "member", authorId: "owner", description: "Member private pin", integer: Long.fromString("9007199254740993") },
      { workspaceId: scope.workspaceId, userId: "owner", description: "Owner private pin" },
    ]);
    const source = await workspaceRecovery(scope.workspaceId, "owner", true);
    await PrivateWorkspace.create({ workspaceId: scope.workspaceId, ownerId: "owner", state: "migrating", migrationId, sourceRevision: source.sourceRevision, leaseUntil: new Date(Date.now() + 60_000) });
    const records = [];
    for (const row of partitionPrivateRecovery(source)) {
      const record = await encryptPrivateRecord(scope.workspaceId, row, directory.signed.directory.members, 1); records.push(record);
      await PrivateRecord.create({ workspaceId: scope.workspaceId, ...record });
    }
    const signed = await signPrivateInitialSnapshot({ records, migrationId, userId: "owner", directory, secrets: owner, current: () => true });
    await preparePrivateInitialSnapshot({ ...scope, userId: "owner", migrationId }, signed.readers);
    const snapshot = await verifyPrivateInitialSnapshot({ signed: signed.readers.find((r) => r.manifest.readerId === "member"), records: privateInitialSnapshotProjection(signed.records, "member"), scope, directory, secrets: member, current: () => true });
    const ownerSnapshot = await verifyPrivateInitialSnapshot({ signed: signed.readers.find((r) => r.manifest.readerId === "owner"), records: privateInitialSnapshotProjection(signed.records, "owner"), scope: { ...scope, userId: "owner" }, directory, secrets: owner, current: () => true });
    const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), { server: scope.server, userId: "owner" });
    const raw = JSON.stringify(await encryptRecoveryKeyBackup({ format: "trackyourtime-workspace-recovery-v1", server: scope.server, ownerId: "owner", snapshot: await workspaceRecovery(scope.workspaceId, "owner") }, key, () => true));
    ownerProof = await createPrivateOwnerMigrationProof({ readBackup: async () => raw, backupKey: key, records, snapshot: ownerSnapshot, directory, userId: "owner", secrets: owner, current: () => true });
    proof = await createPrivateFavoritesMigrationProof({ source: await migrationFavoritesSource(scope.workspaceId, "member", migrationId), snapshot, directory, userId: "member", secrets: member, current: () => true });
  });
  after(dropTestDatabase);
  async function combinedFixture() {
    const db = mongoose.connection.db!;
    await db.collection<{ _id: string; name: string; slug: string }>("organization").insertOne({ _id: scope.workspaceId, name: "Original workspace", slug: "original-workspace" });
    await db.collection("apitokens").insertOne({ workspaceId: scope.workspaceId, userId: "owner", name: "Original API label", tokenHash: "Original token hash" });
    await db.collection("webhooksubscriptions").insertMany([
      { workspaceId: scope.workspaceId, createdBy: "owner", url: "https://private.example.test/owner", secret: "Owner original integration secret" },
      { workspaceId: scope.workspaceId, createdBy: "member", url: "https://private.example.test/member", secret: "Member original integration secret" },
    ]);
    const complete = await capturePrivateMigrationSupplement(scope.workspaceId, "owner");
    await PrivateWorkspace.updateOne({}, { $set: { supplementRevision: complete.sourceRevision } });
    await PrivateRecord.deleteMany({}); await PrivateSnapshotChunk.deleteMany({}); await PrivateSnapshotReader.deleteMany({});
    let offset: number | null = 0;
    do { offset = (await stagePrivateMigrationBatch(scope.workspaceId, "owner", migrationId, offset)).next; } while (offset !== null);
    const records = (await PrivateRecord.find().lean()).map(({ id, kind, authorId, revision, keyCommitment, box, grants }) => ({ id, kind, authorId, revision, keyCommitment, box, grants }));
    const signed = await signPrivateInitialSnapshot({ records, migrationId, userId: "owner", directory, secrets: owner, current: () => true });
    await preparePrivateInitialSnapshot({ ...scope, userId: "owner", migrationId }, signed.readers);
    const ownScope = { ...scope, userId: "owner" };
    const snapshot = await verifyPrivateInitialSnapshot({ signed: signed.readers.find((r) => r.manifest.readerId === "owner"), records: privateInitialSnapshotProjection(signed.records, "owner"), scope: ownScope, directory, secrets: owner, current: () => true });
    const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), ownScope);
    const archive = await combinedWorkspaceRecovery(scope.workspaceId, "owner", scope.server);
    const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, key, () => true));
    const combinedProof = await createPrivateCombinedOwnerMigrationProof({ readBackup: async () => raw, backupKey: key, records, snapshot, directory, userId: "owner", secrets: owner, current: () => true });
    key.fill(0);
    const personal = await personalMigrationSource({ ...scope, migrationId });
    const memberSnapshot = await verifyPrivateInitialSnapshot({ signed: signed.readers.find((r) => r.manifest.readerId === "member"), records: privateInitialSnapshotProjection(signed.records, "member"), scope, directory, secrets: member, current: () => true });
    const memberKey = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), scope);
    const memberRaw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(personal, memberKey, () => true));
    const personalProof = await createPrivatePersonalMigrationProof({ readBackup: async () => memberRaw, backupKey: memberKey, snapshot: memberSnapshot, directory, userId: "member", secrets: member, current: () => true }); memberKey.fill(0);
    return { combinedProof, ownScope, complete, personalProof, personal };
  }
  async function separatedFixture(extraTags = 0) {
    const f = await combinedFixture();
    const legacyReaders = (await PrivateSnapshotReader.find().lean()).map((row) => row.signed);
    await PrivateSnapshotReader.deleteMany({}); await PrivateSnapshotChunk.deleteMany({});
    if (extraTags) {
      await mongoose.connection.db!.collection<{ _id: string; workspaceId: string; name: string }>("tags").insertMany(Array.from({ length: extraTags }, (_, index) => ({ _id: `projection-tag-${index}`, workspaceId: scope.workspaceId, name: `Shared tag ${index}` })));
      const source = await workspaceRecovery(scope.workspaceId, "owner", true);
      await PrivateWorkspace.updateOne({}, { $set: { sourceRevision: source.sourceRevision } });
      let offset: number | null = 0;
      do { offset = (await stagePrivateMigrationBatch(scope.workspaceId, "owner", migrationId, offset)).next; } while (offset !== null);
    }
    const proposal = await privateProjectionProposal({ ...f.ownScope, migrationId });
    const signed = await signPrivateInitialProjectionRoot({ ...proposal, personalDigests: new Map(proposal.personalDigests.map((row) => [row.userId, row.digest])), directory, userId: "owner", secrets: owner, current: () => true });
    return { ...f, proposal, signed, legacyReaders };
  }
  async function projectionReader(userId: string, secrets: typeof owner) {
    const readerScope = { ...scope, userId }, signed = await privateProjectionSnapshotRoot(readerScope);
    async function lane(kind: "shared" | "personal") {
      const rows = []; let offset: number | null = 0, pages = 0;
      do {
        const page = await privateProjectionSnapshotPage({ ...readerScope, migrationId }, kind, offset);
        assert.equal(page.offset, offset); assert.ok(page.records.length <= 100);
        assert.ok(page.records.every((record) => record.grants.length === 1 && record.grants[0]!.userId === userId));
        rows.push(...page.records); offset = page.next; pages++;
      } while (offset !== null);
      return { rows, pages };
    }
    const shared = await lane("shared"), personal = await lane("personal");
    return { snapshot: await verifyPrivateInitialProjection({ signed, sharedRecords: shared.rows, personalRecords: personal.rows, scope: readerScope, directory, secrets, current: () => true }), shared, personal };
  }
  async function projectionProofs() {
    const f = await separatedFixture();
    await preparePrivateProjectionSnapshot({ ...f.ownScope, migrationId }, f.signed);
    const ownerSnapshot = (await projectionReader("owner", owner)).snapshot, memberSnapshot = (await projectionReader("member", member)).snapshot;
    const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), f.ownScope);
    try {
      const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(await combinedWorkspaceRecovery(scope.workspaceId, "owner", scope.server), key, () => true));
      const ownerProof = await createPrivateProjectionOwnerProof({ readBackup: async () => raw, backupKey: key, snapshot: ownerSnapshot, directory, userId: "owner", secrets: owner, current: () => true });
      const personalRaw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(await personalMigrationSource({ ...scope, migrationId }), key, () => true));
      const personalProof = await createPrivateProjectionPersonalProof({ readBackup: async () => personalRaw, backupKey: key, snapshot: memberSnapshot, directory, userId: "member", secrets: member, current: () => true });
      return { ...f, ownerProof, personalProof };
    } finally { key.fill(0); }
  }
  it("records reopened-file owner and personal v3-root proofs idempotently while keeping originals and mode", async () => {
    const { ownScope, ownerProof, personalProof } = await projectionProofs();
    for (let retry = 0; retry < 2; retry++) {
      assert.deepEqual(await recordPrivateProjectionOwnerProof(ownScope, ownerProof), { recorded: true });
      assert.deepEqual(await recordPrivateProjectionPersonalProof(scope, personalProof), { recorded: true });
    }
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 2);
    assert.equal((await PrivateMigrationReceipt.findOne({ kind: "owner" }).lean())!.proof.v, 3);
    assert.equal((await PrivateMigrationReceipt.findOne({ kind: "personal" }).lean())!.proof.v, 2);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal((await PrivateWorkspace.findOne().lean())!.backupVerified, false);
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, ownerProof as never));
    await assert.rejects(recordPrivatePersonalMigrationProof(scope, personalProof as never));
  });
  it("refuses forged, cross-account, wrong-root and wrong-scope new projection receipts", async () => {
    const { ownScope, ownerProof, personalProof } = await projectionProofs();
    const forged = structuredClone(ownerProof); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.proof);
    await assert.rejects(recordPrivateProjectionOwnerProof(ownScope, forged), { code: "FORBIDDEN" });
    await assert.rejects(recordPrivateProjectionOwnerProof(scope, ownerProof), { code: "NOT_FOUND" });
    await assert.rejects(recordPrivateProjectionPersonalProof(ownScope, personalProof), { code: "NOT_FOUND" });
    await assert.rejects(recordPrivateProjectionPersonalProof({ ...scope, server: "https://different.invalid" }, personalProof), { code: "NOT_FOUND" });
    const wrong = structuredClone(ownerProof); wrong.proof.snapshotRoot = "A".repeat(43); wrong.signature = await signPrivateChange(owner.signingPrivateKey, wrong.proof);
    await assert.rejects(recordPrivateProjectionOwnerProof(ownScope, wrong), { code: "CONFLICT" });
    const wrongCount = structuredClone(personalProof); wrongCount.proof.verifiedRecords++; wrongCount.signature = await signPrivateChange(member.signingPrivateKey, wrongCount.proof);
    await assert.rejects(recordPrivateProjectionPersonalProof(scope, wrongCount), { code: "CONFLICT" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("rechecks peer originals, source hashes and frozen reader indexes even on byte-identical new receipt replay", async () => {
    const { ownScope, ownerProof, personalProof } = await projectionProofs();
    await recordPrivateProjectionOwnerProof(ownScope, ownerProof); await recordPrivateProjectionPersonalProof(scope, personalProof);
    const collection = mongoose.connection.db!.collection("webhooksubscriptions");
    await collection.updateOne({ createdBy: "member" }, { $set: { secret: "changed peer secret" } });
    await assert.rejects(recordPrivateProjectionOwnerProof(ownScope, ownerProof), { code: "CONFLICT" });
    await assert.rejects(recordPrivateProjectionPersonalProof(scope, personalProof), { code: "CONFLICT" });
    await collection.updateOne({ createdBy: "member" }, { $set: { secret: "Member original integration secret" } });
    await PrivateProjectionReader.deleteOne({ userId: "member" });
    await assert.rejects(recordPrivateProjectionOwnerProof(ownScope, ownerProof), /incomplete/);
    await assert.rejects(recordPrivateProjectionPersonalProof(scope, personalProof), /incomplete/);
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 2);
  });
  it("requires already-frozen v3 storage and current membership for new receipt submission", async () => {
    const { ownScope, ownerProof, personalProof } = await projectionProofs();
    await PrivateProjectionRoot.deleteMany({});
    await assert.rejects(recordPrivateProjectionOwnerProof(ownScope, ownerProof), /incomplete/);
    assert.equal(await PrivateProjectionRoot.countDocuments(), 0);
    await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "member" });
    await assert.rejects(recordPrivateProjectionPersonalProof(scope, personalProof), { code: "NOT_FOUND" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("stores one common immutable root, paginates independent reader lanes and rechecks idempotent publication", async () => {
    const { ownScope, signed, legacyReaders } = await separatedFixture(105);
    const prepared = await preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed);
    assert.deepEqual(await preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed), prepared);
    await assert.rejects(preparePrivateInitialSnapshot({ ...ownScope, migrationId }, legacyReaders), { code: "CONFLICT" });
    const memberView = await projectionReader("member", member), ownerView = await projectionReader("owner", owner);
    assert.equal(memberView.snapshot.root, prepared.root); assert.equal(ownerView.snapshot.root, prepared.root);
    assert.ok(memberView.shared.pages >= 2); assert.equal(memberView.personal.rows.length, 2); assert.equal(ownerView.personal.rows.length, 3);
    assert.equal(await PrivateProjectionRoot.countDocuments(), 1); assert.equal(await PrivateProjectionReader.countDocuments(), 2);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating"); assert.equal((await PrivateWorkspace.findOne().lean())!.backupVerified, false);
    await PrivateProjectionReader.deleteOne({ userId: "member" });
    await assert.rejects(preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed), /incomplete/);
  });
  it("refuses stale preparation, invalid offsets, a changed stored root and unrelated readers", async () => {
    const { ownScope, signed } = await separatedFixture();
    await preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed);
    await assert.rejects(privateProjectionSnapshotRoot({ ...scope, userId: "stranger" }), { code: "NOT_FOUND" });
    await assert.rejects(privateProjectionSnapshotRoot({ ...scope, server: "https://different.invalid" }), { code: "NOT_FOUND" });
    for (const offset of [-1, 0.5, 400001]) await assert.rejects(privateProjectionSnapshotPage({ ...scope, migrationId }, "personal", offset), { code: "BAD_REQUEST" });
    await assert.rejects(privateProjectionSnapshotPage({ ...scope, migrationId: "different" }, "shared", 0), { code: "NOT_FOUND" });
    await PrivateProjectionRoot.updateOne({}, { $set: { root: "A".repeat(43) } });
    await assert.rejects(privateProjectionSnapshotRoot(scope), /incomplete/);
    await PrivateProjectionRoot.updateOne({}, { $set: { root: await privateRecordDigest(signed.manifest) } });
    await PrivateWorkspace.updateOne({}, { $set: { leaseUntil: new Date(0) } });
    await assert.rejects(privateProjectionSnapshotRoot(scope), { code: "PRECONDITION_FAILED" });
  });
  it("rejects forged/wrong projection roots and mixed old storage before writing any v3 snapshot", async () => {
    const { ownScope, signed } = await separatedFixture();
    const forged = structuredClone(signed); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.manifest);
    await assert.rejects(preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, forged), { code: "FORBIDDEN" });
    const wrong = structuredClone(signed); wrong.manifest.readers[0]!.personalDigest = "A".repeat(43); wrong.signature = await signPrivateChange(owner.signingPrivateKey, wrong.manifest);
    await assert.rejects(preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, wrong), { code: "BAD_REQUEST" });
    assert.equal(await PrivateProjectionRoot.countDocuments(), 0); assert.equal(await PrivateSnapshotChunk.countDocuments(), 0);
    await PrivateSnapshotReader.collection.insertOne({ workspaceId: scope.workspaceId, migrationId, userId: "legacy" });
    await assert.rejects(preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed), { code: "CONFLICT" });
    assert.equal(await PrivateProjectionRoot.countDocuments(), 0);
  });
  it("does not recreate deleted staged rows after a v3 root is frozen and cancellation removes every new artifact", async () => {
    const { ownScope, signed } = await separatedFixture();
    await preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed);
    const row = (await PrivateRecord.findOne().lean())!; await PrivateRecord.deleteOne({ _id: row._id });
    await assert.rejects(stagePrivateMigrationBatch(scope.workspaceId, "owner", migrationId, 0), /already frozen/);
    assert.equal(await PrivateRecord.countDocuments({ _id: row._id }), 0);
    assert.equal(await discardPrivatePreparation(scope.workspaceId, migrationId), true);
    for (const model of [PrivateRecord, PrivateSnapshotChunk, PrivateProjectionRoot, PrivateProjectionReader, PrivateWorkspace]) assert.equal(await model.countDocuments(), 0);
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("keeps another reader's signed projections verifiable after account erasure removes personal ciphertext and indexes", async () => {
    const { ownScope, signed } = await separatedFixture();
    const { root } = await preparePrivateProjectionSnapshot({ ...ownScope, migrationId }, signed);
    await PrivateWorkspace.updateOne({}, { $set: { state: "encrypted", revision: 1, head: root, directoryDigest: directory.digest, sourceRevision: "retired", supplementRevision: "retired", backupVerified: true } });
    await mongooseRowStore.deleteMany("workspaceMembers", { workspaceId: scope.workspaceId, userId: "member" });
    await mongooseRowStore.erasePrivateUserData("member"); await mongooseRowStore.deleteMany("privateAccounts", { userId: "member" });
    assert.equal(await PrivateProjectionReader.countDocuments({ userId: "member" }), 0);
    assert.equal((await projectionReader("owner", owner)).snapshot.root, root);
    assert.equal(await PrivateProjectionRoot.countDocuments(), 1);
    await assert.rejects(privateProjectionSnapshotRoot(scope), { code: "NOT_FOUND" });
  });
  it("delivers a bounded owner proposal without peer private IDs, source checksums or root wrappers and verifies its saved-file approval", async () => {
    const { ownScope } = await combinedFixture();
    const proposal = await privateProjectionProposal({ ...ownScope, migrationId });
    const foreign = await PrivateRecord.find({ workspaceId: scope.workspaceId, authorId: "member", kind: { $in: ["favorites", "integrations"] } }).lean();
    for (const row of foreign) assert.equal(JSON.stringify(proposal).includes(row.id), false);
    assert.equal(Object.hasOwn(proposal, "sourceRevision"), false); assert.equal(Object.hasOwn(proposal, "fullRecordsDigest"), false);
    assert.doesNotMatch(JSON.stringify(proposal), /Member original integration|Member private pin|"recovery"|"passkeys"/);
    assert.equal(proposal.personalDigests.length, 2);
    const signed = await signPrivateInitialProjectionRoot({ ...proposal, personalDigests: new Map(proposal.personalDigests.map((row) => [row.userId, row.digest])), directory, userId: "owner", secrets: owner, current: () => true });
    const snapshot = await verifyPrivateInitialProjection({ signed, sharedRecords: privateInitialSnapshotProjection(proposal.sharedRecords, "owner"), personalRecords: proposal.ownerPersonalRecords, scope: ownScope, directory, secrets: owner, current: () => true });
    const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), ownScope);
    const archive = await combinedWorkspaceRecovery(scope.workspaceId, "owner", scope.server);
    const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, key, () => true));
    const approval = await createPrivateProjectionOwnerProof({ readBackup: async () => raw, backupKey: key, snapshot, directory, userId: "owner", secrets: owner, current: () => true }); key.fill(0);
    assert.equal(approval.proof.snapshotRoot, snapshot.root);
    assert.equal(approval.proof.sourceRevision, archive.snapshot.sourceRevision);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("refuses proposal access for another actor and changed original integration data", async () => {
    const { ownScope } = await combinedFixture();
    await assert.rejects(privateProjectionProposal({ ...scope, migrationId }), { code: "FORBIDDEN" });
    await assert.rejects(privateProjectionProposal({ ...ownScope, migrationId: crypto.randomUUID() }), { code: "PRECONDITION_FAILED" });
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed private original" } });
    await assert.rejects(privateProjectionProposal({ ...ownScope, migrationId }), { code: "CONFLICT" });
  });
  it("rejects incomplete staged records, stale account keys and changed directory permissions without publishing a partial proposal", async () => {
    const { ownScope } = await combinedFixture();
    const row = (await PrivateRecord.findOne().lean())!; await PrivateRecord.deleteOne({ _id: row._id });
    await assert.rejects(privateProjectionProposal({ ...ownScope, migrationId }), /incomplete/);
    await PrivateRecord.create(row);
    const original = (await PrivateAccount.findOne({ userId: "member" }).lean())!.identity.publicKey;
    await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.publicKey": (await createKeyPair()).publicKey } });
    await assert.rejects(privateProjectionProposal({ ...ownScope, migrationId }), /account keys changed/);
    await PrivateAccount.updateOne({ userId: "member" }, { $set: { "identity.publicKey": original } });
    await WorkspaceMember.collection.updateOne({ workspaceId: scope.workspaceId, userId: "member" }, { $set: { canViewOthersTime: true } });
    await assert.rejects(privateProjectionProposal({ ...ownScope, migrationId }), /sharing changed/);
  });
  it("backs up and verifies only the member's private originals, keeping them out of owner receipts", async () => {
    const { personalProof, personal } = await combinedFixture();
    assert.equal(personal.snapshot.collections.favorites.length, 1); assert.equal(personal.supplement.collections.webhooksubscriptions.length, 1);
    assert.equal(personal.supplement.collections.organization.length, 0); assert.equal(personal.supplement.collections.apitokens.length, 0);
    assert.doesNotMatch(JSON.stringify(personal), /Owner private pin|Owner original integration|Original API label|Original workspace/);
    const own = await personalMigrationSource({ ...scope, userId: "owner", migrationId });
    assert.doesNotMatch(JSON.stringify(own), /Member private pin|Member original integration secret/);
    await assert.rejects(personalMigrationSource({ ...scope, userId: "stranger", migrationId }), { code: "NOT_FOUND" });
    assert.deepEqual(await recordPrivatePersonalMigrationProof(scope, personalProof), { recorded: true });
    assert.deepEqual(await recordPrivatePersonalMigrationProof(scope, personalProof), { recorded: true });
    assert.equal(await PrivateMigrationReceipt.countDocuments({ kind: "personal" }), 1);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.doesNotMatch(JSON.stringify(await PrivateMigrationReceipt.find().lean()), /Member original integration|Member private pin/);
    await mongooseRowStore.deleteMany("privateMigrationReceipts", { userId: "member" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("revalidates personal receipts and refuses another account, bad signature, source changes and missing frozen ciphertext", async () => {
    const { personalProof } = await combinedFixture();
    await assert.rejects(recordPrivatePersonalMigrationProof({ ...scope, userId: "owner" }, personalProof), { code: "NOT_FOUND" });
    const forged = structuredClone(personalProof); forged.signature = await signPrivateChange(owner.signingPrivateKey, forged.proof);
    await assert.rejects(recordPrivatePersonalMigrationProof(scope, forged), { code: "FORBIDDEN" });
    const stale = structuredClone(personalProof); stale.proof.supplementRevision = "a".repeat(64); stale.signature = await signPrivateChange(member.signingPrivateKey, stale.proof);
    await assert.rejects(recordPrivatePersonalMigrationProof(scope, stale), { code: "CONFLICT" });
    await recordPrivatePersonalMigrationProof(scope, personalProof);
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed own original" } });
    await assert.rejects(recordPrivatePersonalMigrationProof(scope, personalProof), { code: "CONFLICT" });
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Member original integration secret" } });
    await PrivateSnapshotChunk.deleteMany({ workspaceId: scope.workspaceId });
    await assert.rejects(recordPrivatePersonalMigrationProof(scope, personalProof), { code: "CONFLICT" });
    await PrivateWorkspace.updateOne({}, { $set: { state: "encrypted" } });
    await assert.rejects(personalMigrationSource({ ...scope, migrationId }), { code: "PRECONDITION_FAILED" });
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
  });
  it("stages supplemental originals and records an idempotent combined receipt without changing mode or originals", async () => {
    const { combinedProof, ownScope, complete } = await combinedFixture();
    assert.notEqual(combinedProof.proof.supplementRevision, complete.sourceRevision);
    assert.equal(combinedProof.proof.opaqueRecords, 2);
    assert.deepEqual(await recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof), { recorded: true });
    assert.deepEqual(await recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof), { recorded: true });
    assert.equal(await PrivateMigrationReceipt.countDocuments({ kind: "owner" }), 1);
    const mode = (await PrivateWorkspace.findOne().lean())!; assert.equal(mode.state, "migrating"); assert.equal(mode.backupVerified, false);
    assert.equal(await mongoose.connection.db!.collection("webhooksubscriptions").countDocuments(), 2);
    assert.doesNotMatch(JSON.stringify(await PrivateMigrationReceipt.find().lean()), /Original API label|original integration secret|private.example/);
  });
  it("revalidates opaque integration originals and frozen ciphertext even when replaying a combined receipt", async () => {
    const { combinedProof, ownScope } = await combinedFixture();
    await recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof);
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed member original" } });
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof), { code: "CONFLICT" });
    await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Member original integration secret" } });
    const chunk = (await PrivateSnapshotChunk.findOne({}).lean())!;
    const records = structuredClone(chunk.records); records.find((r) => r.kind === "integrations" && r.authorId === "member")!.box.nonce = "AAAAAAAAAAAAAAAA";
    await PrivateSnapshotChunk.updateOne({ _id: chunk._id }, { $set: { records } });
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof), { code: "CONFLICT" });
  });
  it("refuses a forged signature, another account, changed supplement proof and missing frozen source marker", async () => {
    const { combinedProof, ownScope } = await combinedFixture();
    const forged = structuredClone(combinedProof); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.proof);
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, forged), { code: "FORBIDDEN" });
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(scope, combinedProof), { code: "NOT_FOUND" });
    const changed = structuredClone(combinedProof); changed.proof.supplementRevision = "a".repeat(64); changed.signature = await signPrivateChange(owner.signingPrivateKey, changed.proof);
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, changed), { code: "CONFLICT" });
    await PrivateWorkspace.updateOne({}, { $set: { supplementRevision: null } });
    await assert.rejects(recordPrivateCombinedOwnerMigrationProof(ownScope, combinedProof), { code: "CONFLICT" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("refuses a v1 approval once supplemental originals exist, even without a v2 preparation marker", async () => {
    await mongoose.connection.db!.collection("webhooksubscriptions").insertOne({ workspaceId: scope.workspaceId, createdBy: "member", secret: "Uncovered original" });
    await assert.rejects(recordPrivateOwnerMigrationProof({ ...scope, userId: "owner" }, ownerProof), /combined recovery backup/);
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("returns only the member's typed original favorites, records one idempotent receipt and preserves plaintext source", async () => {
    const source = await migrationFavoritesSource(scope.workspaceId, "member", migrationId);
    assert.equal(source.collections.favorites.length, 1);
    assert.equal(Object.values(source.collections).reduce((sum, rows) => sum + rows.length, 0), 1);
    assert.deepEqual(source.collections.favorites[0]!.integer, { $numberLong: "9007199254740993" });
    assert.doesNotMatch(JSON.stringify(source), /Owner private pin/);
    assert.deepEqual(await recordPrivateFavoritesMigrationProof(scope, proof), { recorded: true });
    assert.deepEqual(await recordPrivateFavoritesMigrationProof(scope, proof), { recorded: true });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 1);
    assert.doesNotMatch(JSON.stringify(await PrivateMigrationReceipt.find().lean()), /Member private pin|Owner private pin|9007199254740993/);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
  });
  it("rejects forged, cross-account, wrong-root and wrong-source acknowledgements before writing receipts", async () => {
    const forged = structuredClone(proof); forged.signature = await signPrivateChange(owner.signingPrivateKey, forged.proof);
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, forged), { code: "FORBIDDEN" });
    await assert.rejects(recordPrivateFavoritesMigrationProof({ ...scope, userId: "owner" }, proof), { code: "NOT_FOUND" });
    const wrongRoot = structuredClone(proof); wrongRoot.proof.snapshotRoot = "A".repeat(43); wrongRoot.signature = await signPrivateChange(member.signingPrivateKey, wrongRoot.proof);
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, wrongRoot), { code: "CONFLICT" });
    const wrongSource = structuredClone(proof); wrongSource.proof.sourceRevision = "a".repeat(64); wrongSource.signature = await signPrivateChange(member.signingPrivateKey, wrongSource.proof);
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, wrongSource), { code: "CONFLICT" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("detects a changed original or staged ciphertext and refuses source access after conversion", async () => {
    await mongoose.connection.db!.collection("favorites").updateOne({ userId: "member" }, { $set: { description: "Changed original" } });
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, proof), { code: "CONFLICT" });
    await mongoose.connection.db!.collection("favorites").updateOne({ userId: "member" }, { $set: { description: "Member private pin" } });
    const row = (await PrivateRecord.findOne({ kind: "favorites", authorId: "member" }).lean())!;
    await PrivateRecord.updateOne({ _id: row._id }, { $set: { "box.nonce": "AAAAAAAAAAAAAAAA" } });
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, proof), { code: "CONFLICT" });
    await PrivateRecord.updateOne({ _id: row._id }, { $set: { "box.nonce": row.box.nonce } });
    const chunk = (await PrivateSnapshotChunk.findOne({ "records.kind": "favorites" }).lean())!;
    const corrupted = structuredClone(chunk.records); corrupted.find((record) => record.kind === "favorites" && record.authorId === "member")!.box.nonce = "AAAAAAAAAAAAAAAA";
    await PrivateSnapshotChunk.updateOne({ _id: chunk._id }, { $set: { records: corrupted } });
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, proof), { code: "CONFLICT" });
    await PrivateWorkspace.updateOne({}, { $set: { state: "encrypted" } });
    await assert.rejects(migrationFavoritesSource(scope.workspaceId, "member", migrationId), { code: "PRECONDITION_FAILED" });
    await assert.rejects(recordPrivateFavoritesMigrationProof(scope, proof), { code: "PRECONDITION_FAILED" });
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
  });
  it("removes personal receipts on account cleanup and keeps both new public methods guarded", async () => {
    await recordPrivateFavoritesMigrationProof(scope, proof);
    await PrivateMigrationReceipt.create({ workspaceId: "former", migrationId: crypto.randomUUID(), userId: "member", kind: "favorites", proof: {}, signature: "synthetic" });
    await mongooseRowStore.deleteMany("privateMigrationReceipts", { userId: "member" });
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
    const caller = privacyRouter.createCaller({ user: { id: "member" }, session: { user: { id: "member" } } } as unknown as Context);
    await assert.rejects(caller.migrationFavoritesSource({ workspaceId: scope.workspaceId, migrationId }), { code: "NOT_IMPLEMENTED" });
    await assert.rejects(caller.acknowledgeMigrationFavorites({ workspaceId: scope.workspaceId, ...proof }), { code: "NOT_IMPLEMENTED" });
    await assert.rejects(migrationFavoritesSource(scope.workspaceId, "stranger", migrationId), { code: "NOT_FOUND" });
  });
  it("records owner approval against the owner-only source and frozen ciphertext without converting or deleting originals", async () => {
    const ownScope = { ...scope, userId: "owner" };
    const complete = await workspaceRecovery(scope.workspaceId, "owner", true);
    assert.notEqual(complete.sourceRevision, ownerProof.proof.sourceRevision);
    assert.deepEqual(await recordPrivateOwnerMigrationProof(ownScope, ownerProof), { recorded: true });
    assert.deepEqual(await recordPrivateOwnerMigrationProof(ownScope, ownerProof), { recorded: true });
    assert.equal(await PrivateMigrationReceipt.countDocuments({ kind: "owner" }), 1);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal((await PrivateWorkspace.findOne().lean())!.backupVerified, false);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
    assert.doesNotMatch(JSON.stringify(await PrivateMigrationReceipt.find({ kind: "owner" }).lean()), /Member private pin|Owner private pin|9007199254740993/);
  });
  it("refuses forged owner approval, another member, another root, counts and complete-source substitution", async () => {
    const ownScope = { ...scope, userId: "owner" };
    const forged = structuredClone(ownerProof); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.proof);
    await assert.rejects(recordPrivateOwnerMigrationProof(ownScope, forged), { code: "FORBIDDEN" });
    await assert.rejects(recordPrivateOwnerMigrationProof(scope, ownerProof), { code: "NOT_FOUND" });
    for (const patch of [{ snapshotRoot: "A".repeat(43) }, { verifiedRecords: 0 }, { opaqueRecords: 0 }, { sourceRevision: (await workspaceRecovery(scope.workspaceId, "owner", true)).sourceRevision }]) {
      const changed = structuredClone(ownerProof); Object.assign(changed.proof, patch); changed.signature = await signPrivateChange(owner.signingPrivateKey, changed.proof);
      await assert.rejects(recordPrivateOwnerMigrationProof(ownScope, changed), { code: "CONFLICT" });
    }
    assert.equal(await PrivateMigrationReceipt.countDocuments(), 0);
  });
  it("invalidates owner approval when another member's opaque original, staged ciphertext or frozen snapshot changes", async () => {
    const ownScope = { ...scope, userId: "owner" };
    await recordPrivateOwnerMigrationProof(ownScope, ownerProof);
    await mongoose.connection.db!.collection("favorites").updateOne({ userId: "member" }, { $set: { description: "Changed opaque preference" } });
    await assert.rejects(recordPrivateOwnerMigrationProof(ownScope, ownerProof), { code: "CONFLICT" });
    await mongoose.connection.db!.collection("favorites").updateOne({ userId: "member" }, { $set: { description: "Member private pin" } });
    const row = (await PrivateRecord.findOne({ authorId: "member" }).lean())!;
    await PrivateRecord.updateOne({ _id: row._id }, { $set: { "box.nonce": "AAAAAAAAAAAAAAAA" } });
    await assert.rejects(recordPrivateOwnerMigrationProof(ownScope, ownerProof), { code: "CONFLICT" });
    await PrivateRecord.updateOne({ _id: row._id }, { $set: { "box.nonce": row.box.nonce } });
    await PrivateSnapshotChunk.deleteMany({ workspaceId: scope.workspaceId });
    await assert.rejects(recordPrivateOwnerMigrationProof(ownScope, ownerProof), { code: "CONFLICT" });
  });
  it("keeps the new owner endpoint and obsolete complete-archive endpoint closed", async () => {
    const caller = privacyRouter.createCaller({ user: { id: "owner" }, session: { user: { id: "owner" } } } as unknown as Context);
    await assert.rejects(caller.acknowledgeMigrationOwner({ workspaceId: scope.workspaceId, ...ownerProof }), { code: "NOT_IMPLEMENTED" });
    await assert.rejects(caller.migrationArchive({ workspaceId: scope.workspaceId, migrationId }), /Legacy migration archives/);
  });

});
