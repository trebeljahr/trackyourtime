import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { before, beforeEach, after, describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { createKeyPair, createSigningPair, createPrivatePreparationRequest, createPrivateOriginalStageRequest, createPrivateProjectionOwnerProof, createPrivateProjectionPersonalProof, deriveRecoveryBackupKey, encryptCombinedRecoveryKeyBackup, encodeSecret, randomSecret, canonicalJson, decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, partitionPrivateRecoverySupplement, privateInitialSnapshotProjection, privateMemberKeyFingerprint, privateSourceSessionBinding, signPrivateChange, signPrivateInitialProjectionRoot, signPrivateWorkspaceDirectory, verifyPrivateInitialProjection, verifyPrivateWorkspaceDirectory, type PlainPrivateRecord, type PublicKey, type VerifiedPrivateDirectory } from "@starter/core";
import { canWritePrivateRecord, type PrivateDirectoryMember, type SignedPrivatePreparationRequest, type SignedPrivateProjectionOwnerProof, type SignedPrivateProjectionPersonalProof } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateMigrationReceipt, PrivatePreparationRequest, PrivateProjectionReader, PrivateProjectionRoot, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateSourceChallengeRequest, PrivateWorkspace, PrivateWorkspaceCommit } from "../models/PrivateData.js";
import { PrivatePreparationReservation } from "../models/PrivatePreparationReservation.js";
import { PrivateAccountErasureFence } from "../models/PrivateAccountErasureFence.js";
import { createPrivatePreparationReservation } from "@starter/core";
import { reservePrivatePreparation } from "../services/privacy/reserve-preparation.js";
import { beginPrivateAccountErasure, fencePrivateAccount } from "../services/privacy/account-erasure-fence.js";
import { assertStandardWorkspace } from "../services/privacy/access.js";
import { privateProjectionSnapshotRoot } from "../services/privacy/projection-snapshots.js";
import { StorageUsage } from "../models/StorageUsage.js";
import { privacyRouter } from "../trpc/routers/privacy.js";
import type { Context } from "../trpc/context.js";
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
import { captureOperatorRecoveryArchive, saveOperatorRecoveryCopy, signOperatorRecoveryProof, verifySavedOperatorRecoveryCopy } from "../services/privacy/operator-recovery.js";
import { recordOperatorRecoveryProof, verifyStoredOperatorRecoveryProof } from "../services/privacy/operator-proof.js";
import { captureOperatorCheckpointArchive, encryptOperatorCheckpointArchive, openOperatorCheckpointArchive, saveOperatorCheckpointCopy, signOperatorCheckpointProof, verifyOperatorCheckpointArchive, verifyOperatorCheckpointProof, verifySavedOperatorCheckpointCopy } from "../services/privacy/operator-checkpoint.js";
import { stagePrivateMigrationBatch, runVerifiedPrivateOriginalStage } from "../services/privacy/migration.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { auditPrivateWorkspaceRetirement } from "../services/privacy/retirement-audit.js";
import { beforeBusinessCommit, withBusinessTransaction } from "../services/business-transaction.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner", sessionId: "current-session" };
let owner: { privateKey: PublicKey; signingPrivateKey: PublicKey }, member: typeof owner, directory: VerifiedPrivateDirectory;
async function request(now?: number) {
  return createPrivatePreparationRequest({ archive: await combinedWorkspaceRecovery(scope.workspaceId, scope.userId, scope.server), directory, userId: scope.userId, sessionId: scope.sessionId, migrationId: crypto.randomUUID(), secrets: owner, current: () => true, now });
}
describe("signed client preparation lease", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-client-preparation", [PrivateAccount, PrivateDirectory, PrivatePreparationRequest, PrivatePreparationReservation, PrivateAccountErasureFence, PrivateWorkspace, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateProjectionRoot, PrivateProjectionReader, PrivateMigrationReceipt, PrivateWorkspaceCommit, PrivateSourceChallengeRequest, WorkspaceMember, WorkspaceWriteFence] as never));
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
    const ownerSnapshot = () => verifyPrivateInitialProjection({ signed, sharedRecords: privateInitialSnapshotProjection(captured.records.filter((row) => !["favorites", "integrations"].includes(row.kind)), "owner"), personalRecords: privateInitialSnapshotProjection(captured.records.filter((row) => ["favorites", "integrations"].includes(row.kind)), "owner"), scope, directory, secrets: owner, current: () => true });
    return { ...f, root, proof, ownerSnapshot, readiness: () => privateProjectionPreparationReadiness(f.workerScope, root) };
  }
  async function reservationFixture() {
    const f = await contentVerification(), key = randomSecret(), operator = await createSigningPair(), folder = await mkdtemp("/private/tmp/trackyourtime-reservation-test-");
    try {
      await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
      await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
      const snapshot = await f.ownerSnapshot();
      const mode = (await PrivateWorkspace.findOne().lean())!;
      const consent = await createPrivatePreparationReservation({ snapshot, directory, modeId: String(mode._id), reservationId: crypto.randomUUID(), sessionId: scope.sessionId, secrets: owner, current: () => true });
      const archive = await captureOperatorCheckpointArchive(f.workerScope, f.root, consent);
      const saved = await saveOperatorCheckpointCopy(join(folder, "checkpoint.tytoperator"), archive, key, process.env.TEST_MONGOD_PATH!);
      assert.deepEqual(archive.reservation, consent);
      assert.match(saved.reservationDigest!, /^[a-f0-9]{64}$/);
      const operatorProof = await signOperatorCheckpointProof(saved, operator.privateKey, operator.publicKey);
      return { ...f, consent, operatorProof, operator, reserve: () => reservePrivatePreparation(scope, consent, operatorProof, operator.publicKey) };
    } finally { key.fill(0); await rm(folder, { recursive: true, force: true }); }
  }
  const needsMongod = { skip: !process.env.TEST_MONGOD_PATH && "TEST_MONGOD_PATH needs an operator-local mongod binary" };
  it("delivers no-store ciphertext bootstrap POSTs only to actual workspace members and their reader projection", async () => {
    const f = await contentVerification(), previousOrigin = env.BETTER_AUTH_URL;
    Object.defineProperty(env, "BETTER_AUTH_URL", { value: scope.server, writable: true, configurable: true });
    try {
      const headers = new Map<string, unknown>();
      const context = (userId: string) => ({ user: { id: userId }, session: { user: { id: userId } }, res: { headersSent: false, setHeader: (key: string, value: unknown) => headers.set(key, value) } }) as unknown as Context;
      const member = privacyRouter.createCaller(context("member")), owner = privacyRouter.createCaller(context("owner"));
      const history = await member.projectionDirectory({ workspaceId: scope.workspaceId, after: 0, through: directory.trust.revision });
      assert.equal(history.directories[0]!.digest, directory.digest);
      assert.doesNotMatch(JSON.stringify(history), /recovery|passkeys|privateKey|original secret/);
      const root = await member.projectionRoot({ workspaceId: scope.workspaceId });
      assert.equal(root.manifest.migrationId, f.workerScope.migrationId);
      assert.deepEqual(await owner.projectionRoot({ workspaceId: scope.workspaceId }), root);
      const page = await member.projectionPage({ workspaceId: scope.workspaceId, migrationId: f.workerScope.migrationId, lane: "personal", offset: 0 });
      assert.ok(page.records.length > 0);
      for (const row of page.records) assert.deepEqual(row.grants.map((grant) => grant.userId), ["member"]);
      const own = await mongoose.connection.db!.collection("favorites").findOne({ userId: "owner" });
      assert.equal(JSON.stringify(page).includes(String(own!._id)), false);
      assert.doesNotMatch(JSON.stringify(page), /original secret|original pin|<Invoice>/);
      assert.equal(headers.get("Cache-Control"), "no-store");
      await assert.rejects(privacyRouter.createCaller(context("outsider")).projectionRoot({ workspaceId: scope.workspaceId }), { code: "NOT_FOUND" });
      await assert.rejects(member.projectionRoot({ workspaceId: scope.workspaceId, userId: "owner" } as never), { code: "BAD_REQUEST" });
      await assert.rejects(member.projectionPage({ workspaceId: scope.workspaceId, migrationId: crypto.randomUUID(), lane: "personal", offset: 0 }), { code: "NOT_FOUND" });
      await assert.rejects(privacyRouter.createCaller({ user: null, session: null } as unknown as Context).projectionRoot({ workspaceId: scope.workspaceId }), { code: "UNAUTHORIZED" });
    } finally { Object.defineProperty(env, "BETTER_AUTH_URL", { value: previousOrigin, writable: true, configurable: true }); }
  });
  it("permanently reserves a verified root before device pins and keeps it readable past all leases", needsMongod, async () => {
    const f = await reservationFixture(), before = (await StorageUsage.findById(scope.workspaceId).lean())!.bytes;
    const expected = { reserved: true, root: f.root, directoryDigest: directory.digest, reservationId: f.consent.request.reservationId };
    assert.deepEqual(await f.reserve(), expected);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "reserved");
    assert.ok((await StorageUsage.findById(scope.workspaceId).lean())!.bytes > before);
    assert.equal((await StorageUsage.findById(scope.workspaceId).lean())!.version, 4);
    const artifacts = JSON.stringify(await PrivateSnapshotChunk.find().lean());
    const clock = mock.method(Date, "now", () => f.operatorProof.proof.expiresAt + 86_400_000);
    try {
      assert.deepEqual(await f.reserve(), expected);
      assert.equal(await discardPrivatePreparation(scope.workspaceId, f.workerScope.migrationId), false);
      assert.equal(await discardPrivatePreparation(scope.workspaceId, f.workerScope.migrationId, true), false);
      await assert.rejects(assertStandardWorkspace(scope.workspaceId), /PRIVATE_WORKSPACE_REQUIRES_UNLOCK/);
      await assert.rejects(runVerifiedPrivateOriginalStage(f.workerScope), /no longer writable/);
      assert.equal((await privateProjectionSnapshotRoot(scope)).manifest.migrationId, f.workerScope.migrationId);
      assert.equal((await privateProjectionSnapshotRoot({ ...scope, userId: "member" })).manifest.migrationId, f.workerScope.migrationId);
    } finally { clock.mock.restore(); }
    for (const userId of ["owner", "member"]) {
      await assert.rejects(beginPrivateAccountErasure(userId), /before deleting this account/);
      await withBusinessTransaction(() => fencePrivateAccount(userId));
    }
    assert.equal(await PrivateAccountErasureFence.countDocuments({ erased: true }), 0);
    await beginPrivateAccountErasure("unrelated");
    assert.equal(await PrivateAccountErasureFence.countDocuments({ erased: true }), 1);
    assert.equal(await PrivateAccount.countDocuments(), 2);
    assert.equal(JSON.stringify(await PrivateSnapshotChunk.find().lean()), artifacts);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
    assert.ok((await auditPrivateWorkspaceRetirement(mongoose.connection.db!, scope.workspaceId)).leaks.some((row) => row.collection === "privatepreparationreservations" && row.reason === "source-checksums"));
    // A partial recovery must still protect keys if the reservation row is
    // missing but the permanent workspace mode survived.
    await PrivatePreparationReservation.collection.deleteMany({ workspaceId: scope.workspaceId });
    for (const userId of ["owner", "member"]) await assert.rejects(beginPrivateAccountErasure(userId), /before deleting this account/);
    assert.equal(await PrivateAccountErasureFence.countDocuments({ erased: true }), 1);
    await assert.rejects(privateProjectionSnapshotRoot(scope), /reservation is missing/);
  });
  it("rolls reservation and its quota/account fences back if mode publication fails", needsMongod, async () => {
    const f = await reservationFixture(), before = (await StorageUsage.findById(scope.workspaceId).lean())!.bytes;
    const failure = mock.method(PrivateWorkspace, "updateOne", async () => { throw new Error("Injected reservation publication failure"); });
    try { await assert.rejects(f.reserve(), /Injected reservation publication failure/); } finally { failure.mock.restore(); }
    assert.equal(await PrivatePreparationReservation.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal((await StorageUsage.findById(scope.workspaceId).lean())!.bytes, before);
    let at = Date.now(); const clock = mock.method(Date, "now", () => at);
    try {
      await assert.rejects(withBusinessTransaction(async () => { await f.reserve(); at = f.consent.request.expiresAt; }), /Reservation consent expired/);
    } finally { clock.mock.restore(); }
    assert.equal(await PrivatePreparationReservation.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal((await StorageUsage.findById(scope.workspaceId).lean())!.bytes, before);
    assert.deepEqual(await f.reserve(), { reserved: true, root: f.root, directoryDigest: directory.digest, reservationId: f.consent.request.reservationId });
  });
  it("refuses expired/cross-session/forged consent and changed operational checkpoints without reserving", needsMongod, async () => {
    const f = await reservationFixture();
    const forged = structuredClone(f.consent); forged.signature = await signPrivateChange(member.signingPrivateKey, forged.request);
    await assert.rejects(reservePrivatePreparation(scope, forged, f.operatorProof, f.operator.publicKey), { code: "FORBIDDEN" });
    await assert.rejects(reservePrivatePreparation({ ...scope, sessionId: "different" }, f.consent, f.operatorProof, f.operator.publicKey), { code: "NOT_FOUND" });
    const clock = mock.method(Date, "now", () => f.consent.request.expiresAt);
    try { await assert.rejects(f.reserve(), /consent expired/); } finally { clock.mock.restore(); }
    const changed = structuredClone(f.operatorProof); changed.proof.controlsDigest = "a".repeat(64); changed.signature = await signPrivateChange(f.operator.privateKey, changed.proof);
    await assert.rejects(reservePrivatePreparation(scope, f.consent, changed, f.operator.publicKey), { code: "CONFLICT" });
    const missingIntent = structuredClone(f.operatorProof); delete missingIntent.proof.reservationDigest; missingIntent.signature = await signPrivateChange(f.operator.privateKey, missingIntent.proof);
    await assert.rejects(reservePrivatePreparation(scope, f.consent, missingIntent, f.operator.publicKey), { code: "CONFLICT" });
    const differentIntent = structuredClone(f.consent); differentIntent.request.reservationId = crypto.randomUUID(); differentIntent.signature = await signPrivateChange(owner.signingPrivateKey, differentIntent.request);
    await assert.rejects(reservePrivatePreparation(scope, differentIntent, f.operatorProof, f.operator.publicKey), { code: "CONFLICT" });
    assert.equal(await PrivatePreparationReservation.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
    assert.equal(await PrivateAccountErasureFence.countDocuments({ erased: true }), 0);
  });
  it("lets an erasure that wins the account fence prevent a late reservation", needsMongod, async () => {
    const f = await reservationFixture(); let release!: () => void, enter!: () => void;
    const ready = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
    const deletion = withBusinessTransaction(async () => { await beginPrivateAccountErasure("member"); enter(); await wait; });
    await ready;
    const refused = assert.rejects(f.reserve(), /Account erasure has started/); release(); await deletion;
    await refused;
    assert.equal(await PrivatePreparationReservation.countDocuments(), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
  });
  it("lets a reservation that wins the account fence refuse deletion before the irreversible marker", needsMongod, async () => {
    const f = await reservationFixture(); let release!: () => void, enter!: () => void;
    const ready = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
    const pending = withBusinessTransaction(async () => { await f.reserve(); enter(); await wait; });
    await ready;
    const refused = assert.rejects(beginPrivateAccountErasure("member"), /before deleting this account/);
    release(); await pending; await refused;
    assert.equal(await PrivateAccountErasureFence.countDocuments({ erased: true }), 0);
    assert.equal((await PrivateWorkspace.findOne().lean())!.state, "reserved");
    assert.equal(await PrivatePreparationReservation.countDocuments(), 1);
  });
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
  it("captures complete operator originals only after current content verification and never substitutes an owner-readable backup", async () => {
    const f = await contentVerification();
    await assert.rejects(captureOperatorRecoveryArchive(f.workerScope, f.root), /verification is incomplete/);
    await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
    await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
    const archive = await captureOperatorRecoveryArchive(f.workerScope, f.root);
    assert.equal(archive.snapshot.collections.favorites.length, 2);
    assert.equal(archive.supplement.collections.webhooksubscriptions.length, 2);
    assert.match(JSON.stringify(archive), /Member original secret/);
    const mode = (await PrivateWorkspace.findOne().lean())!;
    assert.equal(archive.snapshot.sourceRevision, mode.sourceRevision); assert.equal(archive.supplement.sourceRevision, mode.supplementRevision);
    assert.equal(archive.modeId, String(mode._id)); assert.equal(archive.snapshotRoot, f.root);
    assert.equal(mode.state, "migrating"); assert.equal(mode.backupVerified, false);
    const own = await combinedWorkspaceRecovery(scope.workspaceId, "owner", scope.server);
    assert.notEqual(own.snapshot.sourceRevision, archive.snapshot.sourceRevision);
    assert.notEqual(own.supplement.sourceRevision, archive.supplement.sourceRevision);
    await assert.rejects(captureOperatorRecoveryArchive({ ...f.workerScope, userId: "member" }, f.root), { code: "NOT_FOUND" });
    await assert.rejects(captureOperatorRecoveryArchive(f.workerScope, "A".repeat(43)), { code: "CONFLICT" });
  });
  it("backs up and restores the exact frozen ciphertext/control checkpoint with all originals", { skip: !process.env.TEST_MONGOD_PATH && "TEST_MONGOD_PATH needs an operator-local mongod binary" }, async () => {
    const f = await contentVerification(), key = randomSecret(), operator = await createSigningPair();
    const folder = await mkdtemp("/private/tmp/trackyourtime-checkpoint-test-");
    try {
      await assert.rejects(captureOperatorCheckpointArchive(f.workerScope, f.root), /verification is incomplete/);
      await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
      await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
      const archive = await captureOperatorCheckpointArchive(f.workerScope, f.root), expected = {
        server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, migrationId: f.workerScope.migrationId,
        modeId: archive.originals.modeId, directoryDigest: archive.originals.directoryDigest, snapshotRoot: f.root,
      };
      assert.equal(archive.controls.privateworkspaces.length, 1); assert.equal(archive.controls.privateprojectionroots.length, 1);
      assert.equal(archive.controls.privaterecords.length, await PrivateRecord.countDocuments());
      assert.equal(archive.controls.privatemigrationreceipts.length, 2);
      const path = join(folder, "checkpoint.tytoperator");
      const saved = await saveOperatorCheckpointCopy(path, archive, key, process.env.TEST_MONGOD_PATH!);
      assert.equal(saved.controlsDigest, archive.controlsDigest); assert.equal(saved.snapshotRoot, f.root);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const raw = await readFile(path, "utf8");
      assert.doesNotMatch(raw, /Original shared tag|Member original secret|<Invoice>|privaterecords|sourceRevision/);
      assert.equal(raw.includes(Buffer.from(key).toString("base64url")), false);
      assert.deepEqual(await openOperatorCheckpointArchive(JSON.parse(raw), key, expected), archive);
      const proof = await signOperatorCheckpointProof(saved, operator.privateKey, operator.publicKey);
      assert.equal(proof.proof.controlsDigest, archive.controlsDigest);
      assert.deepEqual(await verifyOperatorCheckpointProof(f.workerScope, proof, operator.publicKey), { verified: true });
      await assert.rejects(verifyOperatorCheckpointProof(f.workerScope, proof, (await createSigningPair()).publicKey), { code: "FORBIDDEN" });
      const otherArtifact = structuredClone(proof); otherArtifact.proof.controlsDigest = "a".repeat(64); otherArtifact.signature = await signPrivateChange(operator.privateKey, otherArtifact.proof);
      await assert.rejects(verifyOperatorCheckpointProof(f.workerScope, otherArtifact, operator.publicKey), { code: "CONFLICT" });
      const forged = structuredClone(proof); forged.signature = await signPrivateChange(owner.signingPrivateKey, forged.proof);
      await assert.rejects(verifyOperatorCheckpointProof(f.workerScope, forged, operator.publicKey), { code: "FORBIDDEN" });
      await assert.rejects(verifyOperatorCheckpointProof({ ...f.workerScope, userId: "member" }, proof, operator.publicKey), { code: "NOT_FOUND" });
      let at = Date.now(); const clock = mock.method(Date, "now", () => at);
      try {
        await assert.rejects(withBusinessTransaction(async () => {
          await verifyOperatorCheckpointProof(f.workerScope, proof, operator.publicKey);
          at = proof.proof.expiresAt;
        }), /checkpoint proof expired/);
      } finally { clock.mock.restore(); }
      await assert.rejects(signOperatorCheckpointProof(JSON.parse(JSON.stringify(saved)), operator.privateKey, operator.publicKey), /verified saved operator checkpoint/);
      await assert.rejects(signOperatorCheckpointProof(Object.freeze({ ...saved }), operator.privateKey, operator.publicKey), /verified saved operator checkpoint/);
      const rechecked = await verifySavedOperatorCheckpointCopy(path, key, expected, process.env.TEST_MONGOD_PATH!);
      assert.equal(rechecked.fileSha256, saved.fileSha256);
      await assert.rejects(saveOperatorCheckpointCopy(path, archive, key, process.env.TEST_MONGOD_PATH!), { code: "EEXIST" });
      await assert.rejects(openOperatorCheckpointArchive(JSON.parse(raw), randomSecret(), expected));
      await assert.rejects(openOperatorCheckpointArchive(JSON.parse(raw), key, { ...expected, snapshotRoot: "A".repeat(43) }), /another preparation/);
      const changedHeader = JSON.parse(raw); changedHeader.header.controlsDigest = "a".repeat(64);
      await assert.rejects(openOperatorCheckpointArchive(changedHeader, key, expected));
      const changed = structuredClone(archive); changed.controls.privaterecords.pop();
      await assert.rejects(verifyOperatorCheckpointArchive(changed), /differ from their digest/);
      const changedScope = structuredClone(archive); changedScope.controls.privateworkspaces[0]!.workspaceId = "another";
      await assert.rejects(verifyOperatorCheckpointArchive(changedScope));
      await assert.rejects(encryptOperatorCheckpointArchive(archive, key.slice(0, 16)), /256-bit/);
      await assert.rejects(verifyOperatorCheckpointArchive({ ...archive, controls: { ...archive.controls, arbitrarycollection: [] } }));
      assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
      assert.equal(await PrivateRecord.countDocuments(), archive.controls.privaterecords.length);
      assert.equal((await PrivateWorkspace.findOne().lean())!.state, "migrating");
      assert.equal((await PrivateWorkspace.findOne().lean())!.backupVerified, false);
      await PrivateRecord.updateOne({}, { $set: { "box.data": "changed" } });
      await assert.rejects(captureOperatorCheckpointArchive(f.workerScope, f.root));
      await assert.rejects(verifyOperatorCheckpointProof(f.workerScope, proof, operator.publicKey));
    } finally { key.fill(0); await rm(folder, { recursive: true, force: true }); }
  });
  it("records and revalidates only a current independently signed saved-file/restore proof for the exact preparation", { skip: !process.env.TEST_MONGOD_PATH && "TEST_MONGOD_PATH needs an operator-local mongod binary" }, async () => {
    const f = await contentVerification(), operator = await createSigningPair(), key = randomSecret();
    const directory = await mkdtemp("/private/tmp/trackyourtime-operator-attestation-test-");
    try {
      await assert.rejects(verifyStoredOperatorRecoveryProof(f.workerScope, f.root, operator.publicKey), /independently signed operator backup proof/);
      await recordPrivateProjectionOwnerProof(scope, await f.proof("owner"));
      await recordPrivateProjectionPersonalProof({ ...scope, userId: "member" }, await f.proof("member"));
      const path = join(directory, "originals.tytoperator"), archive = await captureOperatorRecoveryArchive(f.workerScope, f.root);
      const saved = await saveOperatorRecoveryCopy(path, archive, key, process.env.TEST_MONGOD_PATH!);
      const signed = await signOperatorRecoveryProof(saved, operator.privateKey, operator.publicKey);
      const forged = structuredClone(signed); forged.signature = await signPrivateChange(owner.signingPrivateKey, forged.proof);
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, forged, operator.publicKey), { code: "FORBIDDEN" });
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, signed, (await createSigningPair()).publicKey), { code: "FORBIDDEN" });
      const wrong = structuredClone(signed); wrong.proof.sourceRevision = "a".repeat(64); wrong.signature = await signPrivateChange(operator.privateKey, wrong.proof);
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, wrong, operator.publicKey), { code: "CONFLICT" });
      const expired = structuredClone(signed); expired.proof.verifiedAt -= 3_600_001; expired.proof.expiresAt -= 3_600_001; expired.signature = await signPrivateChange(operator.privateKey, expired.proof);
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, expired, operator.publicKey), /expired/);
      await assert.rejects(recordOperatorRecoveryProof({ ...f.workerScope, userId: "member" }, signed, operator.publicKey), { code: "NOT_FOUND" });
      assert.equal((await PrivateWorkspace.findOne().lean())!.operatorBackup, null);
      assert.deepEqual(await recordOperatorRecoveryProof(f.workerScope, signed, operator.publicKey), { recorded: true });
      assert.deepEqual(await recordOperatorRecoveryProof(f.workerScope, signed, operator.publicKey), { recorded: true });
      assert.deepEqual(await verifyStoredOperatorRecoveryProof(f.workerScope, f.root, operator.publicKey), { recorded: true });
      const rechecked = await verifySavedOperatorRecoveryCopy(path, key, { server: archive.server, workspaceId: archive.workspaceId, ownerId: archive.ownerId, migrationId: archive.migrationId, modeId: archive.modeId, directoryDigest: archive.directoryDigest, snapshotRoot: archive.snapshotRoot }, process.env.TEST_MONGOD_PATH!);
      const renewed = await signOperatorRecoveryProof(rechecked, operator.privateKey, operator.publicKey);
      assert.deepEqual(await recordOperatorRecoveryProof(f.workerScope, renewed, operator.publicKey), { recorded: true });
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, signed, operator.publicKey), { code: "CONFLICT" });
      let restoreClock: (() => void) | undefined;
      try {
        await assert.rejects(withBusinessTransaction(async () => {
          beforeBusinessCommit(async () => { const clock = mock.method(Date, "now", () => renewed.proof.expiresAt + 1); restoreClock = () => clock.mock.restore(); });
          await verifyStoredOperatorRecoveryProof(f.workerScope, f.root, operator.publicKey);
        }), /Operator backup proof expired/);
      } finally { restoreClock?.(); }
      const mode = (await PrivateWorkspace.findOne().lean())!;
      assert.equal(mode.state, "migrating"); assert.equal(mode.backupVerified, false); assert.equal(mode.head, null);
      await assert.rejects(verifyStoredOperatorRecoveryProof(f.workerScope, "A".repeat(43), operator.publicKey), { code: "CONFLICT" });
      await PrivateWorkspace.updateOne({}, { $set: { "operatorBackup.signature": forged.signature } });
      await assert.rejects(verifyStoredOperatorRecoveryProof(f.workerScope, f.root, operator.publicKey), { code: "FORBIDDEN" });
      await PrivateWorkspace.updateOne({}, { $set: { operatorBackup: renewed } });
      await mongoose.connection.db!.collection("webhooksubscriptions").updateOne({ createdBy: "member" }, { $set: { secret: "Changed after operator verification" } });
      await assert.rejects(recordOperatorRecoveryProof(f.workerScope, signed, operator.publicKey), /Original data changed/);
    } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
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
