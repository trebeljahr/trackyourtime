import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RECOVERY_KINDS, type PrivateWorkspaceDirectory, type WorkspaceRecovery } from "@starter/shared";
import { canonicalJson, createKeyPair, createSigningPair, decodeSecret } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, privateRecordsToRecovery } from "../privacy/records.js";
import { createPrivateFavoritesMigrationProof, createPrivateMigrationProof, createPrivateOwnerMigrationProof } from "../privacy/migration-proof.js";
import { deriveRecoveryBackupKey, encryptRecoveryKeyBackup } from "../privacy/recovery-backup.js";
import { encodeSecret, randomSecret } from "../privacy/crypto.js";
import { privateInitialSnapshotProjection, signPrivateInitialSnapshot, verifyPrivateInitialSnapshot } from "../privacy/initial-snapshot.js";
async function fixture() {
  const pair = await createKeyPair(), signing = await createSigningPair(), member = await createKeyPair(), memberSigning = await createSigningPair();
  const directory: PrivateWorkspaceDirectory = { v: 1, server: "https://api.example.test", workspaceId: "workspace", revision: 1, previousDigest: null, ownerId: "owner", members: [
    { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey },
    { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: member.publicKey, signingPublicKey: memberSigning.publicKey },
  ] };
  const fingerprints = new Map(await Promise.all(directory.members.map(async (row) => [row.userId, await privateMemberKeyFingerprint(directory.server, row)] as const)));
  const signed = await signPrivateWorkspaceDirectory(directory, signing.privateKey, null, fingerprints);
  const verified = await verifyPrivateWorkspaceDirectory(signed, directory, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const collections = emptyRecoveryCollections();
  RECOVERY_KINDS.forEach((kind, index) => {
    const row: Record<string, unknown> = { _id: { $oid: (index + 1).toString(16).padStart(24, "0") }, workspaceId: "workspace", userId: "owner", authorId: "owner", createdBy: "owner", createdAt: { $date: { $numberLong: "1792800000000" } }, linkedId: { $oid: "000000000000000000000001" }, hugeInt64: { $numberLong: "9007199254740993" } };
    if (kind === "entryoperations") row._id = "durable-operation-receipt";
    if (kind === "timeentries" || kind === "workspacemembers") row.hourlyRate = { $numberDouble: "75.0" };
    if (kind === "projects") { row.hourlyRate = { $numberDouble: "100.0" }; row.budgetAmount = { $numberDecimal: "12345.6700" }; row.budgetCurrency = "EUR"; }
    if (kind === "clients") row.billing = { legalName: "Synthetic client", reference: "original reference" };
    if (kind === "workspacesettings") row.defaultHourlyRate = { $numberInt: "80" };
    if (kind === "invoices") row.xml = '<Invoice id="original">€ — exact issued XML</Invoice>';
    collections[kind].push(row);
  });
  const source: WorkspaceRecovery = { v: 1, workspaceId: "workspace", createdAt: "2026-10-24T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections };
  const recipients = verified.signed.directory.members;
  const records = [];
  for (const row of partitionPrivateRecovery(source)) records.push(await encryptPrivateRecord("workspace", row, recipients, 1));
  const favorite = { _id: "private-member-favorite", workspaceId: "workspace", userId: "member", description: "Not owner-readable", originalInteger: { $numberLong: "9007199254740993" } };
  records.push(await encryptPrivateRecord("workspace", { kind: "favorites", id: "private-member-favorite", authorId: "member", value: favorite }, recipients, 1));
  const options = { source, records, directory: verified, userId: "owner", migrationId: crypto.randomUUID(), secrets: { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey }, current: () => true };
  return { options, recipients, pair, favorite, memberSecrets: { privateKey: member.privateKey, signingPrivateKey: memberSigning.privateKey } };
}
async function memberProofFixture() {
  const f = await fixture(), alive = { value: true };
  const signed = await signPrivateInitialSnapshot(f.options);
  const header = signed.readers.find((reader) => reader.manifest.readerId === "member")!;
  const snapshot = await verifyPrivateInitialSnapshot({ signed: header, records: privateInitialSnapshotProjection(signed.records, "member"), scope: { server: f.options.directory.signed.directory.server, workspaceId: "workspace", userId: "member" }, directory: f.options.directory, secrets: f.memberSecrets, current: () => alive.value });
  const collections = emptyRecoveryCollections(); collections.favorites.push(f.favorite);
  const source: WorkspaceRecovery = { v: 1, workspaceId: "workspace", createdAt: f.options.source.createdAt, collections, sourceRevision: await recoveryDigest(collections) };
  return { f, alive, options: { source, snapshot, directory: f.options.directory, userId: "member", secrets: f.memberSecrets, current: () => alive.value } };
}
it("lets a member verify their private favorites without exposing source values to the owner receipt", async () => {
  const { options } = await memberProofFixture();
  const signed = await createPrivateFavoritesMigrationProof(options);
  assert.equal(signed.proof.verifiedRecords, 1);
  assert.equal(signed.proof.sourceRevision, options.source.sourceRevision);
  assert.equal(signed.proof.snapshotRoot, options.snapshot.signed.manifest.root);
  assert.doesNotMatch(JSON.stringify(signed), /Not owner-readable|9007199254740993|private-member-favorite/);
  const publicKey = options.directory.signed.directory.members.find((member) => member.userId === "member")!.signingPublicKey;
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(signed.proof))));
});
it("refuses changed, missing, cross-account or non-favorite original source data", async () => {
  const { f, options } = await memberProofFixture();
  const changed = structuredClone(options.source); changed.collections.favorites[0]!.description = "Changed source"; changed.sourceRevision = await recoveryDigest(changed.collections);
  await assert.rejects(createPrivateFavoritesMigrationProof({ ...options, source: changed }), /differ from/);
  const missing = structuredClone(options.source); missing.collections.favorites = []; missing.sourceRevision = await recoveryDigest(missing.collections);
  await assert.rejects(createPrivateFavoritesMigrationProof({ ...options, source: missing }), /differ from/);
  const another = structuredClone(options.source); another.collections.favorites[0]!.userId = "owner"; another.sourceRevision = await recoveryDigest(another.collections);
  await assert.rejects(createPrivateFavoritesMigrationProof({ ...options, source: another }), /another account/);
  const mixed = structuredClone(options.source); mixed.collections.invoices = f.options.source.collections.invoices; mixed.sourceRevision = await recoveryDigest(mixed.collections);
  await assert.rejects(createPrivateFavoritesMigrationProof({ ...options, source: mixed }), /favorites-only/);
});
it("does not acknowledge a member's preferences after locking or with another account's snapshot", async () => {
  const { options, alive, f } = await memberProofFixture();
  await assert.rejects(createPrivateFavoritesMigrationProof({ ...options, userId: "owner", secrets: f.options.secrets }), /current verified/);
  const pending = createPrivateFavoritesMigrationProof(options); alive.value = false;
  await assert.rejects(pending, /changed during|current verified/);
});
it("checks all fourteen collections after encryption without losing BSON types, issued XML or links, and reports opaque personal records", async () => {
  const { options } = await fixture();
  const result = await createPrivateMigrationProof(options);
  assert.equal(result.proof.sourceRevision, options.source.sourceRevision); assert.equal(result.proof.verifiedRecords, partitionPrivateRecovery(options.source).length); assert.equal(result.proof.opaqueRecords, 1);
  assert.equal(result.signature.length, 86);
  const shuffled = await createPrivateMigrationProof({ ...options, records: [...options.records].reverse().map((row) => ({ ...row, deleted: false })) });
  assert.equal(shuffled.proof.recordsDigest, result.proof.recordsDigest);
});
it("refuses altered decrypted content, missing records, substituted audiences and tombstones", async () => {
  const { options, recipients } = await fixture();
  await assert.rejects(createPrivateMigrationProof({ ...options, records: options.records.slice(1) }), /missing source/);
  const rows = [...options.records], index = rows.findIndex((row) => row.kind === "invoices"), original = partitionPrivateRecovery(options.source).find((row) => row.kind === "invoices")!;
  rows[index] = await encryptPrivateRecord("workspace", { ...original, value: { ...original.value, xml: "changed XML" } }, recipients, 1);
  await assert.rejects(createPrivateMigrationProof({ ...options, records: rows }), /differs from/);
  const bad = structuredClone(options.records); bad[0]!.grants[0]!.userId = "member";
  await assert.rejects(createPrivateMigrationProof({ ...options, records: bad }), /recipients/);
  await assert.rejects(createPrivateMigrationProof({ ...options, records: options.records.map((row) => ({ ...row, deleted: true })) }));
});
it("refuses changed source checksums, duplicate rows, wrong owner keys and late verification after locking", async () => {
  const { options } = await fixture();
  await assert.rejects(createPrivateMigrationProof({ ...options, records: [...options.records, options.records[0]!] }), /Duplicate/);
  await assert.rejects(createPrivateMigrationProof({ ...options, source: { ...options.source, sourceRevision: "a".repeat(64) } }), /checksum/);
  await assert.rejects(createPrivateMigrationProof({ ...options, userId: "member" }), /verified workspace owner/);
  await assert.rejects(createPrivateMigrationProof({ ...options, secrets: { ...options.secrets, privateKey: (await createKeyPair()).privateKey } }), /do not match/);
  let checks = 0;
  await assert.rejects(createPrivateMigrationProof({ ...options, current: () => ++checks < 3 }), /changed during/);
});
it("refuses colliding Mongo string/ObjectId identifiers instead of silently omitting a source record", async () => {
  const { options } = await fixture();
  const original = options.source.collections.clients[0]!;
  options.source.collections.clients.push({ ...original, _id: (original._id as { $oid: string }).$oid });
  options.source.sourceRevision = await recoveryDigest(options.source.collections);
  await assert.rejects(createPrivateMigrationProof(options), /IDs collide/);
});

it("rebuilds the complete owner-readable BSON recovery copy from decrypted records and refuses missing or overlapping money data", async () => {
  const { options, pair } = await fixture();
  const plaintext = [];
  for (const row of options.records) if (row.grants.some((grant) => grant.userId === "owner")) plaintext.push(await decryptPrivateRecord("workspace", row, "owner", pair.privateKey));
  const restored = await privateRecordsToRecovery("workspace", plaintext, options.source.createdAt);
  assert.deepEqual(restored, options.source);
  await assert.rejects(privateRecordsToRecovery("workspace", plaintext.filter((row) => row.kind !== "entryMoney")), /missing its matching money/);
  await assert.rejects(privateRecordsToRecovery("workspace", plaintext.filter((row) => row.kind !== "entries")), /orphaned money/);
  await assert.rejects(privateRecordsToRecovery("workspace", plaintext.filter((row) => row.kind !== "memberMoney")), /missing its matching money/);
  await assert.rejects(privateRecordsToRecovery("workspace", plaintext.filter((row) => row.kind !== "members")), /orphaned money/);
  const bad = structuredClone(plaintext); bad.find((row) => row.kind === "entryMoney")!.value.authorId = "owner";
  await assert.rejects(privateRecordsToRecovery("workspace", bad), /unexpected data/);
});

async function ownerProofFixture() {
  const f = await fixture(), alive = { value: true };
  const signed = await signPrivateInitialSnapshot(f.options);
  const scope = { server: f.options.directory.signed.directory.server, workspaceId: "workspace", userId: "owner" };
  const snapshot = await verifyPrivateInitialSnapshot({ signed: signed.readers.find((reader) => reader.manifest.readerId === "owner"), records: privateInitialSnapshotProjection(signed.records, "owner"), scope, directory: f.options.directory, secrets: f.options.secrets, current: () => alive.value });
  const key = await deriveRecoveryBackupKey(encodeSecret(randomSecret()), scope);
  const archive = { format: "trackyourtime-workspace-recovery-v1" as const, server: scope.server, ownerId: "owner", snapshot: f.options.source };
  const raw = JSON.stringify(await encryptRecoveryKeyBackup(archive, key, () => true));
  const options = { readBackup: async () => raw, backupKey: key, records: f.options.records, snapshot, directory: f.options.directory, userId: "owner", secrets: f.options.secrets, current: () => alive.value };
  return { f, alive, archive, raw, options };
}
it("reopens an actual encrypted original file before signing the exact migration root and ciphertext commitment", async () => {
  const { options, raw, f } = await ownerProofFixture();
  const folder = await mkdtemp(join(tmpdir(), "tyt-owner-proof-"));
  try {
    const file = join(folder, "original.tytrecovery"); await writeFile(file, raw, { mode: 0o600 });
    assert.doesNotMatch(await readFile(file, "utf8"), /Synthetic client|original reference|numberLong/);
    const result = await createPrivateOwnerMigrationProof({ ...options, readBackup: () => readFile(file, "utf8") });
    assert.equal(result.proof.sourceRevision, f.options.source.sourceRevision);
    assert.equal(result.proof.snapshotRoot, options.snapshot.signed.manifest.root);
    assert.equal(result.proof.verifiedRecords, partitionPrivateRecovery(f.options.source).length);
    assert.equal(result.proof.opaqueRecords, 1);
    assert.equal(result.proof.backupBytes, new TextEncoder().encode(raw).length);
    assert.equal(result.proof.backupDigest, Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))).toString("hex"));
    assert.doesNotMatch(JSON.stringify(result), /Synthetic client|original reference|numberLong|private-member-favorite/);
    const publicKey = options.directory.signed.directory.members.find((member) => member.userId === "owner")!.signingPublicKey;
    const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(result.signature, 64), new TextEncoder().encode(canonicalJson(result.proof))));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("refuses unreadable, truncated, corrupted, wrong-key or mismatched original backup files", async () => {
  const { options, archive } = await ownerProofFixture();
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => { throw new Error("File missing"); } }), /File missing/);
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => "{" }));
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, backupKey: randomSecret() }));
  const changed = structuredClone(archive); changed.snapshot.collections.invoices[0]!.xml = "Different saved XML"; changed.snapshot.sourceRevision = await recoveryDigest(changed.snapshot.collections);
  const raw = JSON.stringify(await encryptRecoveryKeyBackup(changed, options.backupKey, () => true));
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => raw }), /differs from/);
  const corrupt = JSON.parse(await options.readBackup()); corrupt.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => JSON.stringify(corrupt) }));
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => "x".repeat(36 * 1024 * 1024 + 1) }), /Invalid encrypted/);
});
it("does not approve another valid snapshot, an unverified snapshot or completion after a lock", async () => {
  const { options, f, alive } = await ownerProofFixture();
  const changed = [...options.records]; const index = changed.findIndex((row) => row.kind === "favorites" && row.authorId === "member");
  changed[index] = await encryptPrivateRecord("workspace", { kind: "favorites", id: f.favorite._id, authorId: "member", value: f.favorite }, f.recipients, 1);
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, records: changed }), /another initial snapshot/);
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, snapshot: JSON.parse(JSON.stringify(options.snapshot)) }), /current verified/);
  await assert.rejects(createPrivateOwnerMigrationProof({ ...options, readBackup: async () => { alive.value = false; return options.readBackup(); } }), /changed during/);
});
it("captures ciphertext and the purpose key before reading the file without wiping caller-owned keys", async () => {
  const { options } = await ownerProofFixture(), before = new Uint8Array(options.backupKey);
  const result = await createPrivateOwnerMigrationProof({ ...options, readBackup: async () => { options.records[0]!.box.nonce = "AAAAAAAAAAAAAAAA"; return options.readBackup(); } });
  assert.equal(result.proof.snapshotRoot, options.snapshot.signed.manifest.root); assert.deepEqual(options.backupKey, before);
});
