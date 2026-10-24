import { z } from "zod";
import { encryptedRecordSchema, RECOVERY_KINDS, privateFavoritesMigrationProofSchema, privateOwnerMigrationProofSchema, type SignedPrivateOwnerMigrationProof, type EncryptedRecord, type WorkspaceRecovery, type SignedPrivateFavoritesMigrationProof } from "@starter/shared";
import { canonicalJson, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, partitionPrivateRecovery, readersForPrivateRecord } from "./records.js";
import { verifyWorkspaceRecovery } from "./recovery.js";
import { assertPrivateInitialSnapshot, privateInitialSnapshotProjection, privateInitialSnapshotRoot, type VerifiedPrivateInitialSnapshot } from "./initial-snapshot.js";
import { verifyRecoveryKeyBackup } from "./recovery-backup.js";
import { privateRecordDigest } from "./workspace-edits.js";
const migrationRecordSchema = encryptedRecordSchema.extend({ deleted: z.literal(false).optional() });
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Compare every owner-readable source record against decrypted staged data.
 * Typed EJSON is compared directly: no conversion to JS numbers, remapped IDs,
 * invoice normalization or omitted XML. Other people's private favorites may
 * be opaque; report them explicitly, never claim their plaintext was checked.
 * This is a client proof primitive, not an API that enables live conversion. */
export async function createPrivateMigrationProof(options: {
  source: WorkspaceRecovery; records: readonly unknown[]; directory: VerifiedPrivateDirectory;
  userId: string; migrationId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}) {
  const { current, userId, migrationId, secrets } = options;
  const check = () => { if (!current()) throw new Error("Private migration changed during verification"); };
  check();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(migrationId)) throw new Error("Invalid private migration ID");
  const directory = options.directory, { server, workspaceId, ownerId } = directory.signed.directory;
  if (ownerId !== userId) throw new Error("Only the verified workspace owner can approve migration");
  const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  if (options.records.length > 400_000 || new TextEncoder().encode(JSON.stringify(options.records)).length > MAX_ARCHIVE_BYTES) throw new Error("Encrypted migration archive is too large");
  const records: EncryptedRecord[] = options.records.map((row) => {
    const { deleted: _deleted, ...record } = migrationRecordSchema.parse(row);
    return record;
  });
  const source = await verifyWorkspaceRecovery(structuredClone(options.source), workspaceId); check();
  const expected = new Map(partitionPrivateRecovery(source).map((row) => [address(row), row]));
  const remaining = new Set(expected.keys());
  const required = new Set([...expected.values()].filter((row) => readersForPrivateRecord(row.kind, row.authorId, access.recipients).some((member) => member.userId === userId)).map(address));
  const seen = new Set<string>(); let verifiedRecords = 0, opaqueRecords = 0;
  for (const row of records) {
    check(); const key = address(row);
    if (seen.has(key) || row.revision !== 1) throw new Error("Duplicate or unexpected migration revision");
    seen.add(key);
    const readers = readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((member) => member.userId).sort();
    const grants = row.grants.map((grant) => grant.userId).sort();
    if (new Set(grants).size !== grants.length || canonicalJson(readers) !== canonicalJson(grants)) throw new Error("Migration recipients do not match the verified sharing directory");
    const original = expected.get(key);
    if (original) remaining.delete(key);
    if (original && original.authorId !== row.authorId) throw new Error("Migration record changed authorship");
    if (!readers.includes(userId)) { opaqueRecords++; continue; }
    if (!original) throw new Error("Unexpected owner-readable migration record");
    const plain = await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); check();
    if (canonicalJson(plain) !== canonicalJson(original)) throw new Error("Decrypted migration data differs from the original backup");
    required.delete(key); verifiedRecords++;
  }
  if (required.size || remaining.size) throw new Error("Encrypted migration is missing source records");
  const ordered = [...records].sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
  const proof = { v: 1 as const, protocol: "trackyourtime-private-migration-proof-v1" as const, server, workspaceId, userId: userId, migrationId: migrationId, sourceRevision: source.sourceRevision, directoryDigest: directory.digest, recordsDigest: await digest(ordered), verifiedRecords, opaqueRecords };
  check(); const signature = await signPrivateChange(secrets.signingPrivateKey, proof); check();
  return { proof, signature };
}

/** The owner cannot decrypt another member's favorites. That member compares
 * their independently captured typed source with their verified initial
 * snapshot and signs only the private subset's checksum and count. No other
 * person's plaintext or account keys are included in this receipt. */
export async function createPrivateFavoritesMigrationProof(options: {
  source: WorkspaceRecovery; snapshot: VerifiedPrivateInitialSnapshot; directory: VerifiedPrivateDirectory;
  userId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivateFavoritesMigrationProof> {
  const { current, directory, userId, secrets, snapshot } = options;
  const { server, workspaceId } = directory.signed.directory;
  const check = () => {
    if (!current()) throw new Error("Private migration changed during favorites verification");
    assertPrivateInitialSnapshot(snapshot, { server, workspaceId, userId }, directory.digest);
  };
  check();
  const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  const source = await verifyWorkspaceRecovery(structuredClone(options.source), workspaceId); check();
  if (RECOVERY_KINDS.some((kind) => kind !== "favorites" && source.collections[kind].length)) throw new Error("A private favorites proof needs a favorites-only source copy");
  const originals = partitionPrivateRecovery(source);
  if (originals.some((row) => row.kind !== "favorites" || row.authorId !== userId)) throw new Error("Favorites source belongs to another account");
  const expected = new Map(originals.map((row) => [address(row), row]));
  const records = snapshot.records.filter((row) => row.kind === "favorites");
  if (records.length !== expected.size) throw new Error("Encrypted favorites differ from the original source copy");
  for (const record of records) {
    check();
    if (record.authorId !== userId || record.grants.length !== 1 || record.grants[0]!.userId !== userId) throw new Error("Encrypted favorites belong to another account");
    const original = expected.get(address(record));
    const plain = await decryptPrivateRecord(workspaceId, record, userId, access.privateKey); check();
    if (!original || canonicalJson(original) !== canonicalJson(plain)) throw new Error("Encrypted favorites differ from the original source copy");
    expected.delete(address(record));
  }
  if (expected.size) throw new Error("Encrypted favorites are missing original records");
  const manifest = snapshot.signed.manifest;
  const proof = privateFavoritesMigrationProofSchema.parse({
    v: 1, protocol: "trackyourtime-private-favorites-proof-v1", server, workspaceId, userId,
    migrationId: manifest.migrationId, directoryDigest: directory.digest, snapshotRoot: manifest.root,
    sourceRevision: source.sourceRevision, recordsDigest: await digest(records), verifiedRecords: records.length,
  });
  check();
  const signature = await signPrivateChange(access.signingPrivateKey, proof); check();
  return { proof, signature };
}

/** Reopen the actual saved encrypted file before signing approval. The reader
 * must read the user-held destination, never echo the pre-write source object.
 * A signature attests this client check; the server cannot prove possession of
 * an offline file. The independent operational restore drill is still needed.
 * Nothing here changes workspace mode or authorizes source deletion. */
export async function createPrivateOwnerMigrationProof(options: {
  readBackup: () => Promise<string>; backupKey: Uint8Array; records: readonly unknown[];
  snapshot: VerifiedPrivateInitialSnapshot; directory: VerifiedPrivateDirectory;
  userId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivateOwnerMigrationProof> {
  const { snapshot, directory, userId, current, secrets } = options;
  const { server, workspaceId, ownerId } = directory.signed.directory;
  const check = () => {
    if (!current()) throw new Error("Private migration changed during backup verification");
    assertPrivateInitialSnapshot(snapshot, { server, workspaceId, userId }, directory.digest);
  };
  check();
  if (ownerId !== userId) throw new Error("Only the verified workspace owner can approve migration");
  // Capture caller-owned inputs before the file read yields control.
  if (options.records.length > 400_000 || new TextEncoder().encode(JSON.stringify(options.records)).length > MAX_ARCHIVE_BYTES) throw new Error("Encrypted migration archive is too large");
  const records = options.records.map((row) => {
    const { deleted: _deleted, ...record } = migrationRecordSchema.parse(row); return record;
  });
  const key = new Uint8Array(options.backupKey);
  try {
    const raw = await options.readBackup(); check();
    if (typeof raw !== "string" || raw.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const bytes = new TextEncoder().encode(raw);
    if (!bytes.length || bytes.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const archive = await verifyRecoveryKeyBackup(JSON.parse(raw), key, { server, ownerId: userId, workspaceId }); check();
    const content = await createPrivateMigrationProof({ source: archive.snapshot, records, directory, userId, migrationId: snapshot.signed.manifest.migrationId, secrets, current }); check();
    records.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
    const root = await privateInitialSnapshotRoot({ server, workspaceId, migrationId: content.proof.migrationId, directoryDigest: directory.digest }, await privateRecordDigest(records)); check();
    if (root !== snapshot.signed.manifest.root || await privateRecordDigest(privateInitialSnapshotProjection(records, userId)) !== snapshot.signed.manifest.recordsDigest) throw new Error("Original backup verification belongs to another initial snapshot");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); check();
    const proof = privateOwnerMigrationProofSchema.parse({
      ...content.proof, protocol: "trackyourtime-private-owner-proof-v1", snapshotRoot: root,
      backupDigest: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""), backupBytes: bytes.length,
    });
    const signature = await signPrivateChange(secrets.signingPrivateKey, proof); check();
    return { proof, signature };
  } finally { key.fill(0); }
}
