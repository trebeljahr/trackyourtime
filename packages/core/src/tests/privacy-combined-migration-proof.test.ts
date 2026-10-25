import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateOwnerMigrationProofSchema, type CombinedWorkspaceRecoveryArchive, type PrivateWorkspaceDirectory } from "@starter/shared";
import { canonicalJson, createKeyPair, createSigningPair, decodeSecret, encodeSecret, randomSecret } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { emptyRecoverySupplementCollections, partitionPrivateRecoverySupplement, recoverySupplementDigest } from "../privacy/recovery-supplement.js";
import { decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery } from "../privacy/records.js";
import { privateInitialSnapshotProjection, signPrivateInitialSnapshot, verifyPrivateInitialSnapshot } from "../privacy/initial-snapshot.js";
import { deriveRecoveryBackupKey, encryptRecoveryKeyBackup } from "../privacy/recovery-backup.js";
import { encryptCombinedRecoveryKeyBackup } from "../privacy/combined-recovery-backup.js";
import { createPrivatePersonalMigrationProof } from "../privacy/personal-migration-proof.js";
import { createPrivateCombinedOwnerMigrationProof } from "../privacy/combined-migration-proof.js";

async function fixture() {
  const owner = await createKeyPair(), signing = await createSigningPair(), member = await createKeyPair(), memberSigning = await createSigningPair(), alive = { value: true };
  const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
  const directory: PrivateWorkspaceDirectory = { v: 1, server: scope.server, workspaceId: scope.workspaceId, revision: 1, previousDigest: null, ownerId: "owner", members: [
    { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: owner.publicKey, signingPublicKey: signing.publicKey },
    { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: member.publicKey, signingPublicKey: memberSigning.publicKey },
  ] };
  const fingerprints = new Map(await Promise.all(directory.members.map(async (row) => [row.userId, await privateMemberKeyFingerprint(scope.server, row)] as const)));
  const signed = await signPrivateWorkspaceDirectory(directory, signing.privateKey, null, fingerprints);
  const verified = await verifyPrivateWorkspaceDirectory(signed, directory, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const collections = emptyRecoveryCollections(), supplemental = emptyRecoverySupplementCollections(), createdAt = "2026-10-25T00:00:00.000Z";
  collections.timeentries.push({ _id: "entry", workspaceId: "workspace", authorId: "owner", description: "Original exact task", hourlyRate: { $numberDecimal: "12.3400" } });
  collections.invoices.push({ _id: "invoice", workspaceId: "workspace", createdBy: "owner", xml: '<Invoice id="original">€ exact XML</Invoice>' });
  supplemental.organization.push({ _id: "workspace", name: "Original organization", metadata: { original: true } });
  supplemental.apitokens.push({ _id: "token", workspaceId: "workspace", userId: "owner", name: "Private API name", tokenHash: "Original token hash" });
  supplemental.webhooksubscriptions.push({ _id: "hook", workspaceId: "workspace", createdBy: "owner", secret: "Owner original secret" });
  const archive: CombinedWorkspaceRecoveryArchive = { format: "trackyourtime-workspace-recovery-v2", server: scope.server, ownerId: "owner", snapshot: { v: 1, workspaceId: "workspace", createdAt, sourceRevision: await recoveryDigest(collections), collections }, supplement: { v: 1, workspaceId: "workspace", createdAt, sourceRevision: await recoverySupplementDigest(supplemental), collections: supplemental } };
  const originals = [...partitionPrivateRecovery(archive.snapshot), ...partitionPrivateRecoverySupplement(archive.supplement)];
  const records = [];
  for (const row of originals) records.push(await encryptPrivateRecord("workspace", row, directory.members, 1));
  records.push(await encryptPrivateRecord("workspace", { kind: "favorites", id: "member-favorite", authorId: "member", value: { _id: "member-favorite", workspaceId: "workspace", userId: "member", description: "Other private favorite" } }, directory.members, 1));
  records.push(await encryptPrivateRecord("workspace", { kind: "integrations", id: "webhooksubscriptions:member-hook", authorId: "member", value: { _id: "member-hook", workspaceId: "workspace", createdBy: "member", secret: "Other creator secret" } }, directory.members, 1));
  const secrets = { privateKey: owner.privateKey, signingPrivateKey: signing.privateKey }, current = () => alive.value, migrationId = crypto.randomUUID();
  const initial = await signPrivateInitialSnapshot({ records, migrationId, userId: "owner", directory: verified, secrets, current });
  const snapshot = await verifyPrivateInitialSnapshot({ signed: initial.readers.find((reader) => reader.manifest.readerId === "owner"), records: privateInitialSnapshotProjection(initial.records, "owner"), scope, directory: verified, secrets, current });
  const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), scope);
  const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, key, current));
  const options = { readBackup: async () => raw, backupKey: key, records, snapshot, directory: verified, userId: "owner", secrets, current };
  return { archive, raw, options, alive, originals, signing, scope, memberSecrets: { privateKey: member.privateKey, signingPrivateKey: memberSigning.privateKey }, initial };
}
it("reopens the actual combined file and signs both exact source checksums, ciphertext root and encrypted file bytes", async () => {
  const f = await fixture(), folder = await mkdtemp(join(tmpdir(), "tyt-combined-proof-"));
  try {
    const file = join(folder, "original.tytrecovery"); await writeFile(file, f.raw, { mode: 0o600 });
    const result = await createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: () => readFile(file, "utf8") });
    assert.equal(result.proof.sourceRevision, f.archive.snapshot.sourceRevision);
    assert.equal(result.proof.supplementRevision, f.archive.supplement.sourceRevision);
    assert.equal(result.proof.verifiedRecords, f.originals.length); assert.equal(result.proof.opaqueRecords, 2);
    assert.equal(result.proof.snapshotRoot, f.options.snapshot.signed.manifest.root);
    assert.equal(result.proof.backupBytes, Buffer.byteLength(f.raw));
    assert.equal(result.proof.backupDigest, Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.raw))).toString("hex"));
    assert.equal(privateOwnerMigrationProofSchema.safeParse(result.proof).success, false);
    assert.doesNotMatch(JSON.stringify(result), /Owner original secret|Other creator secret|member-hook|Original organization|Private API name|exact XML/);
    const key = await crypto.subtle.importKey("jwk", f.signing.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(result.signature, 64), new TextEncoder().encode(canonicalJson(result.proof))));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("refuses old-format files, missing files, wrong keys, damaged ciphertext and another workspace", async () => {
  const f = await fixture();
  const old = await encryptRecoveryKeyBackup({ format: "trackyourtime-workspace-recovery-v1", server: f.scope.server, ownerId: "owner", snapshot: f.archive.snapshot }, f.options.backupKey, () => true);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: async () => JSON.stringify(old) }));
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: async () => { throw new Error("File missing"); } }), /File missing/);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, backupKey: randomSecret() }));
  const corrupt = JSON.parse(f.raw); corrupt.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: async () => JSON.stringify(corrupt) }));
  const wrong = structuredClone(f.archive); wrong.snapshot.workspaceId = "another";
  await assert.rejects(encryptCombinedRecoveryKeyBackup(wrong, f.options.backupKey, () => true));
});
it("refuses missing or changed integration originals even when the primary source is identical", async () => {
  const f = await fixture();
  for (const mutate of [
    (a: CombinedWorkspaceRecoveryArchive) => { a.supplement.collections.webhooksubscriptions = []; },
    (a: CombinedWorkspaceRecoveryArchive) => { a.supplement.collections.webhooksubscriptions[0]!.secret = "Changed original secret"; },
  ]) {
    const changed = structuredClone(f.archive); mutate(changed); changed.supplement.sourceRevision = await recoverySupplementDigest(changed.supplement.collections);
    const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(changed, f.options.backupKey, () => true));
    await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: async () => raw }), /Unexpected owner-readable|differs from/);
  }
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, records: f.options.records.filter((row) => row.kind !== "workspaceIdentity") }), /missing combined/);
});
it("refuses duplicated, deleted, substituted-audience and changed opaque ciphertext", async () => {
  const f = await fixture();
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, records: [...f.options.records, f.options.records[0]] }), /Duplicate/);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, records: f.options.records.map((row) => ({ ...row, deleted: true })) }));
  const grants = structuredClone(f.options.records); grants.find((row) => row.kind === "integrations" && row.authorId === "member")!.grants.push(grants.find((row) => row.authorId === "owner")!.grants[0]!);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, records: grants }), /recipients/);
  const opaque = structuredClone(f.options.records); opaque.find((row) => row.kind === "integrations" && row.authorId === "member")!.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, records: opaque }), /another initial snapshot/);
});
it("rejects forged snapshot brands and invalidation after file I/O; captures caller inputs without clearing its key", async () => {
  const f = await fixture(), before = new Uint8Array(f.options.backupKey);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, snapshot: JSON.parse(JSON.stringify(f.options.snapshot)) }), /current verified/);
  const proof = await createPrivateCombinedOwnerMigrationProof({ ...f.options, records: [...f.options.records].reverse(), readBackup: async () => { f.options.records[0]!.box.nonce = "AAAAAAAAAAAAAAAA"; return f.raw; } });
  assert.equal(proof.proof.snapshotRoot, f.options.snapshot.signed.manifest.root); assert.deepEqual(f.options.backupKey, before);
  await assert.rejects(createPrivateCombinedOwnerMigrationProof({ ...f.options, readBackup: async () => { f.alive.value = false; return f.raw; } }), /changed during/);
});

async function personalFixture() {
  const f = await fixture(), scope = { ...f.scope, userId: "member" };
  const snapshot = await verifyPrivateInitialSnapshot({ signed: f.initial.readers.find((r) => r.manifest.readerId === "member"), records: privateInitialSnapshotProjection(f.initial.records, "member"), scope, directory: f.options.directory, secrets: f.memberSecrets, current: () => f.alive.value });
  const favorites = await decryptPrivateRecord("workspace", f.options.records.find((r) => r.kind === "favorites")!, "member", f.memberSecrets.privateKey);
  const hook = await decryptPrivateRecord("workspace", f.options.records.find((r) => r.kind === "integrations" && r.authorId === "member")!, "member", f.memberSecrets.privateKey);
  const collections = emptyRecoveryCollections(), supplemental = emptyRecoverySupplementCollections();
  collections.favorites.push(favorites.value); supplemental.webhooksubscriptions.push(hook.value);
  const archive = { ...f.archive, ownerId: "member", snapshot: { ...f.archive.snapshot, collections, sourceRevision: await recoveryDigest(collections) }, supplement: { ...f.archive.supplement, collections: supplemental, sourceRevision: await recoverySupplementDigest(supplemental) } };
  const backupKey = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), scope);
  const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, backupKey, () => true));
  const options = { ...f.options, userId: "member", secrets: f.memberSecrets, snapshot, backupKey, readBackup: async () => raw };
  return { f, options, archive };
}
it("verifies a member's saved favorites and integration originals without full workspace ciphertext or other creators' data", async () => {
  const { options, archive } = await personalFixture();
  const proof = await createPrivatePersonalMigrationProof(options);
  assert.equal(proof.proof.verifiedRecords, 2); assert.equal(proof.proof.supplementRevision, archive.supplement.sourceRevision);
  assert.equal(proof.proof.snapshotRoot, options.snapshot.signed.manifest.root);
  assert.doesNotMatch(JSON.stringify(proof), /Other creator secret|member-hook|Other private favorite|Owner original/);
});
it("refuses missing, changed or shared originals in a personal backup", async () => {
  const { options, archive } = await personalFixture();
  for (const change of [
    (a: CombinedWorkspaceRecoveryArchive) => { a.supplement.collections.webhooksubscriptions = []; },
    (a: CombinedWorkspaceRecoveryArchive) => { a.supplement.collections.webhooksubscriptions[0]!.secret = "Changed saved secret"; },
    (a: CombinedWorkspaceRecoveryArchive) => { a.supplement.collections.organization.push({ _id: "workspace", name: "Shared originals do not belong here" }); },
  ]) {
    const changed = structuredClone(archive); change(changed); changed.supplement.sourceRevision = await recoverySupplementDigest(changed.supplement.collections);
    const raw = JSON.stringify(await encryptCombinedRecoveryKeyBackup(changed, options.backupKey, () => true));
    await assert.rejects(createPrivatePersonalMigrationProof({ ...options, readBackup: async () => raw }), /differ from|only this account/);
  }
});
it("refuses another account's snapshot, old files, wrong keys and locking during personal file verification", async () => {
  const { f, options, archive } = await personalFixture();
  await assert.rejects(createPrivatePersonalMigrationProof({ ...options, snapshot: f.options.snapshot }), /current verified/);
  await assert.rejects(createPrivatePersonalMigrationProof({ ...options, backupKey: randomSecret() }));
  const old = await encryptRecoveryKeyBackup({ format: "trackyourtime-workspace-recovery-v1", server: f.scope.server, ownerId: "member", snapshot: archive.snapshot }, options.backupKey, () => true);
  await assert.rejects(createPrivatePersonalMigrationProof({ ...options, readBackup: async () => JSON.stringify(old) }));
  await assert.rejects(createPrivatePersonalMigrationProof({ ...options, readBackup: async () => { f.alive.value = false; return options.readBackup(); } }), /changed during/);
});
