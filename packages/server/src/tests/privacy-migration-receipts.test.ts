import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { Long } from "mongodb";
import { createKeyPair, createSigningPair, createPrivateFavoritesMigrationProof, encryptPrivateRecord, partitionPrivateRecovery, privateMemberKeyFingerprint, privateInitialSnapshotProjection, randomSecret, seal, signPrivateChange, signPrivateInitialSnapshot, signPrivateWorkspaceDirectory, verifyPrivateInitialSnapshot, verifyPrivateWorkspaceDirectory, type PublicKey, type VerifiedPrivateDirectory } from "@starter/core";
import type { PrivateDirectoryMember, SignedPrivateFavoritesMigrationProof } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { migrationFavoritesSource, workspaceRecovery } from "../services/privacy/recovery.js";
import { commitPrivateDirectory } from "../services/privacy/directories.js";
import { preparePrivateInitialSnapshot } from "../services/privacy/initial-snapshots.js";
import { recordPrivateFavoritesMigrationProof } from "../services/privacy/migration-receipts.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "member" };
let migrationId: string, directory: VerifiedPrivateDirectory, people: PrivateDirectoryMember[], proof: SignedPrivateFavoritesMigrationProof;
let owner: { privateKey: PublicKey; signingPrivateKey: PublicKey }, member: typeof owner;
describe("private preferences conversion receipts", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-migration-receipts", [PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, WorkspaceMember, WorkspaceWriteFence] as never));
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
    proof = await createPrivateFavoritesMigrationProof({ source: await migrationFavoritesSource(scope.workspaceId, "member", migrationId), snapshot, directory, userId: "member", secrets: member, current: () => true });
  });
  after(dropTestDatabase);
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
});
