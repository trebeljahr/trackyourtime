import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateProjectionOwnerProof, createPrivateProjectionPersonalProof } from "../privacy/projection-migration-proof.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { emptyRecoverySupplementCollections, recoverySupplementDigest } from "../privacy/recovery-supplement.js";
import { deriveRecoveryBackupKey } from "../privacy/recovery-backup.js";
import { encryptCombinedRecoveryKeyBackup } from "../privacy/combined-recovery-backup.js";
import { createKeyPair, createSigningPair, decodeSecret, encodeSecret, randomSecret, canonicalJson } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { decryptPrivateRecord, encryptPrivateRecord } from "../privacy/records.js";
import { privateInitialSnapshotProjection } from "../privacy/initial-snapshot.js";
import { privateRecordDigest } from "../privacy/workspace-edits.js";
import { assertPrivateProjectionSnapshot, signPrivateInitialProjectionRoot, verifyPrivateInitialProjection } from "../privacy/projection-snapshot.js";
import type { EncryptedRecord, PrivateDirectoryMember } from "@starter/shared";
const base = { server: "https://api.example.test", workspaceId: "workspace" };
async function fixture() {
  const people: PrivateDirectoryMember[] = [], secrets = new Map<string, { privateKey: Awaited<ReturnType<typeof createKeyPair>>["privateKey"]; signingPrivateKey: Awaited<ReturnType<typeof createSigningPair>>["privateKey"] }>();
  for (const userId of ["manager", "member", "owner"]) {
    const pair = await createKeyPair(), signing = await createSigningPair();
    people.push({ userId, role: userId === "owner" ? "owner" : "member", canViewOthersTime: userId !== "member", canViewOthersMoney: userId !== "member", publicKey: pair.publicKey, signingPublicKey: signing.publicKey });
    secrets.set(userId, { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey });
  }
  const fingerprints = new Map(await Promise.all(people.map(async (person) => [person.userId, await privateMemberKeyFingerprint(base.server, person)] as const)));
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, ...base, revision: 1, previousDigest: null, ownerId: "owner", members: people }, secrets.get("owner")!.signingPrivateKey, null, fingerprints);
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, base, { ownerId: "owner", signingPublicKey: people[2]!.signingPublicKey, revision: 0, digest: null });
  const shared = [
    await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: "shared-tag", authorId: null, value: { workspaceId: base.workspaceId, name: "Shared original" } }, people, 1),
    await encryptPrivateRecord(base.workspaceId, { kind: "entries", id: "owner-entry", authorId: "owner", value: { workspaceId: base.workspaceId, authorId: "owner", description: "Restricted colleague time" } }, people, 1),
  ];
  const personal = new Map<string, EncryptedRecord[]>();
  for (const userId of ["member", "owner"]) personal.set(userId, [
    await encryptPrivateRecord(base.workspaceId, { kind: "favorites", id: `${userId}-private-favorite`, authorId: userId, value: { _id: `${userId}-private-favorite`, workspaceId: base.workspaceId, userId, description: `${userId} secret favorite` } }, people, 1),
    await encryptPrivateRecord(base.workspaceId, { kind: "integrations", id: `webhooksubscriptions:${userId}-private-hook`, authorId: userId, value: { _id: `${userId}-private-hook`, workspaceId: base.workspaceId, createdBy: userId, secret: `${userId} secret integration` } }, people, 1),
  ]);
  personal.set("manager", []);
  const personalDigests = new Map(await Promise.all([...personal].map(async ([userId, records]) => [userId, await privateRecordDigest(records)] as const)));
  const alive = { value: true }, current = () => alive.value;
  const options = { sharedRecords: shared, ownerPersonalRecords: personal.get("owner")!, personalDigests, migrationId: crypto.randomUUID(), directory, userId: "owner", secrets: secrets.get("owner")!, current };
  const signed = await signPrivateInitialProjectionRoot(options);
  const reader = (userId: string) => ({ signed, sharedRecords: privateInitialSnapshotProjection(shared, userId), personalRecords: personal.get(userId)!, scope: { ...base, userId }, directory, secrets: secrets.get(userId)!, current });
  return { options, signed, reader, shared, personal, alive, people };
}
it("verifies all reader projections using one owner-signed root without exposing another creator's personal IDs or counts", async () => {
  const f = await fixture(), roots = [];
  assert.doesNotMatch(JSON.stringify(f.signed), /member-private-favorite|member-private-hook|secret favorite|secret integration|recordCount|opaqueRecords/);
  for (const userId of ["manager", "member", "owner"]) {
    const options = f.reader(userId), snapshot = await verifyPrivateInitialProjection(options);
    assertPrivateProjectionSnapshot(snapshot, options.scope, options.directory.digest); roots.push(snapshot.root);
    assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.sharedRecords));
    assert.equal(snapshot.personalRecords.length, userId === "manager" ? 0 : 2);
    assert.equal(snapshot.sharedRecords.length, userId === "member" ? 1 : 2);
    if (userId === "member") assert.doesNotMatch(JSON.stringify(snapshot.sharedRecords), /owner-entry/);
  }
  assert.equal(new Set(roots).size, 1);
});
it("rejects substituted or truncated shared and personal projections even when other creators' commitments remain opaque", async () => {
  const f = await fixture(), reader = f.reader("member");
  const replacement = await encryptPrivateRecord(base.workspaceId, { kind: "tags", id: "shared-tag", authorId: null, value: { workspaceId: base.workspaceId, name: "Forged shared view" } }, f.people, 1);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, sharedRecords: privateInitialSnapshotProjection([replacement], "member") }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, sharedRecords: [] }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, personalRecords: [] }), /incomplete or differs/);
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, personalRecords: [...reader.personalRecords, replacement] }), /namespace or key binding/);
  const root = structuredClone(f.signed); root.manifest.readers[1]!.sharedDigest = await privateRecordDigest(privateInitialSnapshotProjection([replacement], "member"));
  await assert.rejects(verifyPrivateInitialProjection({ ...reader, signed: root }), /signature/);
});
it("refuses missing recipients, unbound keys, another creator's personal records and incomplete reader commitments before signing", async () => {
  const f = await fixture(), options = f.options;
  const shared = structuredClone(f.shared); shared[0]!.grants = shared[0]!.grants.filter((grant) => grant.userId === "owner");
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, sharedRecords: shared }), /Shared recipients/);
  const { keyCommitment: _key, ...legacy } = f.shared[0]!;
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, sharedRecords: [legacy] }), /key binding/);
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, ownerPersonalRecords: f.personal.get("member")! }), /Another creator/);
  const missing = new Map(options.personalDigests); missing.delete("manager");
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, personalDigests: missing }), /Every verified reader/);
  const wrong = new Map(options.personalDigests); wrong.set("owner", "A".repeat(43));
  await assert.rejects(signPrivateInitialProjectionRoot({ ...options, personalDigests: wrong }), /Owner personal commitment/);
});
it("rejects another scope, forged provenance and unlock changes, and captures mutable signing inputs before awaiting crypto", async () => {
  const f = await fixture(), options = f.reader("owner");
  await assert.rejects(verifyPrivateInitialProjection({ ...options, scope: { ...options.scope, server: "https://other.example.test" } }), /verified workspace directory/);
  const snapshot = await verifyPrivateInitialProjection(options);
  assert.throws(() => assertPrivateProjectionSnapshot(JSON.parse(JSON.stringify(snapshot)), options.scope, options.directory.digest), /current verified/);
  const originalId = f.options.migrationId;
  const signing = signPrivateInitialProjectionRoot(f.options); f.options.migrationId = crypto.randomUUID();
  assert.equal((await signing).manifest.migrationId, originalId);
  const verification = verifyPrivateInitialProjection(options); f.alive.value = false;
  await assert.rejects(verification, /changed during/);
  assert.throws(() => assertPrivateProjectionSnapshot(snapshot, options.scope, options.directory.digest), /current verified/);
});

async function contentFixture(userId = "owner") {
  const f = await fixture(), credentials = f.reader(userId).secrets;
  const rawTag = { _id: "original-tag", workspaceId: base.workspaceId, name: "Exact original tag", hugeInteger: { $numberLong: "9007199254740993" } };
  const shared = [await encryptPrivateRecord(base.workspaceId, { id: "original-tag", kind: "tags", authorId: null, value: rawTag }, f.people, 1)];
  const signed = await signPrivateInitialProjectionRoot({ ...f.options, sharedRecords: shared });
  const snapshot = await verifyPrivateInitialProjection({ ...f.reader(userId), signed, sharedRecords: privateInitialSnapshotProjection(shared, userId) });
  const collections = emptyRecoveryCollections(), supplemental = emptyRecoverySupplementCollections();
  if (userId === "owner") collections.tags.push(rawTag);
  for (const row of f.personal.get(userId)!) {
    const plain = await decryptPrivateRecord(base.workspaceId, row, userId, credentials.privateKey);
    if (plain.kind === "favorites") collections.favorites.push(plain.value); else supplemental.webhooksubscriptions.push(plain.value);
  }
  const createdAt = "2026-10-25T00:00:00.000Z";
  const archive = { format: "trackyourtime-workspace-recovery-v2" as const, server: base.server, ownerId: userId, snapshot: { v: 1 as const, workspaceId: base.workspaceId, createdAt, collections, sourceRevision: await recoveryDigest(collections) }, supplement: { v: 1 as const, workspaceId: base.workspaceId, createdAt, collections: supplemental, sourceRevision: await recoverySupplementDigest(supplemental) } };
  const backupKey = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), { server: base.server, userId });
  const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, backupKey, () => true));
  return { f, archive, raw, options: { snapshot, directory: f.options.directory, userId, secrets: credentials, current: f.options.current, backupKey, readBackup: async () => raw } };
}
it("reopens a saved original file and signs exact owner source checksums, projection root and encrypted bytes without foreign personal IDs", async () => {
  const { options, archive, raw } = await contentFixture(), folder = await mkdtemp(join(tmpdir(), "tyt-projection-proof-"));
  try {
    const file = join(folder, "original.tytrecovery"); await writeFile(file, raw, { mode: 0o600 });
    const proof = await createPrivateProjectionOwnerProof({ ...options, readBackup: () => readFile(file, "utf8") });
    assert.equal(proof.proof.sourceRevision, archive.snapshot.sourceRevision); assert.equal(proof.proof.supplementRevision, archive.supplement.sourceRevision);
    assert.equal(proof.proof.snapshotRoot, options.snapshot.root); assert.equal(proof.proof.verifiedRecords, 3);
    assert.equal(proof.proof.backupBytes, Buffer.byteLength(raw));
    assert.doesNotMatch(JSON.stringify(proof), /member-private|secret favorite|secret integration|hugeInteger|opaqueRecords/);
    const key = await crypto.subtle.importKey("jwk", options.directory.signed.directory.members.find((m) => m.userId === "owner")!.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(proof.signature, 64), new TextEncoder().encode(canonicalJson(proof.proof))));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("checks personal saved-file content against only that member's personal projection", async () => {
  const { options, archive } = await contentFixture("member");
  const proof = await createPrivateProjectionPersonalProof(options);
  assert.equal(proof.proof.verifiedRecords, 2); assert.equal(proof.proof.snapshotRoot, options.snapshot.root);
  assert.equal(proof.proof.sourceRevision, archive.snapshot.sourceRevision);
  await assert.rejects(createPrivateProjectionOwnerProof(options), /Only the verified owner/);
  const shared = structuredClone(archive); shared.snapshot.collections.tags.push({ _id: "extra", workspaceId: base.workspaceId }); shared.snapshot.sourceRevision = await recoveryDigest(shared.snapshot.collections);
  const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(shared, options.backupKey, () => true));
  await assert.rejects(createPrivateProjectionPersonalProof({ ...options, readBackup: async () => raw }), /only this account/);
});
it("refuses changed or missing original secrets, wrong file keys, unverified snapshots and locking during saved-file verification", async () => {
  const { f, options, archive } = await contentFixture();
  const changed = structuredClone(archive); changed.supplement.collections.webhooksubscriptions[0]!.secret = "Changed original secret"; changed.supplement.sourceRevision = await recoverySupplementDigest(changed.supplement.collections);
  const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(changed, options.backupKey, () => true));
  await assert.rejects(createPrivateProjectionOwnerProof({ ...options, readBackup: async () => raw }), /Saved originals differ/);
  await assert.rejects(createPrivateProjectionOwnerProof({ ...options, backupKey: randomSecret() }));
  await assert.rejects(createPrivateProjectionOwnerProof({ ...options, readBackup: async () => { throw new Error("File missing"); } }), /File missing/);
  await assert.rejects(createPrivateProjectionOwnerProof({ ...options, snapshot: JSON.parse(JSON.stringify(options.snapshot)) }), /current verified/);
  const before = new Uint8Array(options.backupKey); await createPrivateProjectionOwnerProof(options); assert.deepEqual(options.backupKey, before);
  await assert.rejects(createPrivateProjectionOwnerProof({ ...options, readBackup: async () => { f.alive.value = false; return options.readBackup(); } }), /changed during/);
});
