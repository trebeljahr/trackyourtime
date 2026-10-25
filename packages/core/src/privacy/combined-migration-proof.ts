import { z } from "zod";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, privateCombinedOwnerMigrationProofSchema, type EncryptedRecord, type SignedPrivateCombinedOwnerMigrationProof } from "@starter/shared";
import { canonicalJson, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, partitionPrivateRecovery, readersForPrivateRecord } from "./records.js";
import { partitionPrivateRecoverySupplement } from "./recovery-supplement.js";
import { assertPrivateInitialSnapshot, privateInitialSnapshotProjection, privateInitialSnapshotRoot, type VerifiedPrivateInitialSnapshot } from "./initial-snapshot.js";
import { verifyCombinedRecoveryKeyBackup } from "./combined-recovery-backup.js";
import { privateRecordDigest } from "./workspace-edits.js";

const recordSchema = encryptedRecordSchema.extend({ deleted: z.literal(false).optional() });
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reopen the saved v2 file and compare both typed datasets to the verified
 * ciphertext snapshot. Other creators' private records remain opaque and need
 * their own receipts. This attests a client check, not physical file retention
 * or a complete operational restore; it cannot change mode or delete source. */
export async function createPrivateCombinedOwnerMigrationProof(options: {
  readBackup: () => Promise<string>; backupKey: Uint8Array; records: readonly unknown[];
  snapshot: VerifiedPrivateInitialSnapshot; directory: VerifiedPrivateDirectory;
  userId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivateCombinedOwnerMigrationProof> {
  const { snapshot, directory, userId, secrets, current } = options;
  const { server, workspaceId, ownerId } = directory.signed.directory;
  const check = () => {
    if (!current()) throw new Error("Private migration changed during combined backup verification");
    assertPrivateInitialSnapshot(snapshot, { server, workspaceId, userId }, directory.digest);
  };
  check();
  if (userId !== ownerId) throw new Error("Only the verified workspace owner can approve migration");
  const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  // Capture mutable caller-owned ciphertext and purpose key before file I/O.
  if (options.records.length > 400_000 || new TextEncoder().encode(JSON.stringify(options.records)).length > PRIVATE_SNAPSHOT_MAX_BYTES) throw new Error("Encrypted migration archive is too large");
  const records: EncryptedRecord[] = options.records.map((row) => {
    const { deleted: _deleted, ...record } = recordSchema.parse(row); return record;
  });
  records.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
  const key = new Uint8Array(options.backupKey);
  try {
    const raw = await options.readBackup(); check();
    if (typeof raw !== "string" || !raw.length || raw.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const bytes = new TextEncoder().encode(raw);
    if (bytes.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const archive = await verifyCombinedRecoveryKeyBackup(JSON.parse(raw), key, { server, ownerId: userId, workspaceId }); check();
    const expected = new Map([...partitionPrivateRecovery(archive.snapshot), ...partitionPrivateRecoverySupplement(archive.supplement)].map((row) => [address(row), row]));
    const seen = new Set<string>(); let verifiedRecords = 0, opaqueRecords = 0;
    for (const row of records) {
      check(); const id = address(row);
      if (row.revision !== 1 || seen.has(id)) throw new Error("Duplicate or unexpected migration revision");
      seen.add(id);
      const readers = readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((member) => member.userId).sort();
      const grants = row.grants.map((grant) => grant.userId).sort();
      if (new Set(grants).size !== grants.length || canonicalJson(readers) !== canonicalJson(grants)) throw new Error("Migration recipients do not match the verified sharing directory");
      if (!readers.includes(userId)) {
        if ((row.kind !== "favorites" && row.kind !== "integrations") || expected.has(id)) throw new Error("Unexpected opaque migration record");
        opaqueRecords++; continue;
      }
      const original = expected.get(id);
      if (!original || original.authorId !== row.authorId) throw new Error("Unexpected owner-readable migration record");
      const plain = await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); check();
      if (canonicalJson(plain) !== canonicalJson(original)) throw new Error("Decrypted migration data differs from the combined original backup");
      expected.delete(id); verifiedRecords++;
    }
    if (expected.size) throw new Error("Encrypted migration is missing combined source records");
    const manifest = snapshot.signed.manifest;
    const root = await privateInitialSnapshotRoot({ server, workspaceId, migrationId: manifest.migrationId, directoryDigest: directory.digest }, await privateRecordDigest(records)); check();
    if (root !== manifest.root || await privateRecordDigest(privateInitialSnapshotProjection(records, userId)) !== manifest.recordsDigest) throw new Error("Combined backup verification belongs to another initial snapshot");
    check();
    const proof = privateCombinedOwnerMigrationProofSchema.parse({
      v: 2, protocol: "trackyourtime-private-owner-proof-v2", server, workspaceId, userId,
      migrationId: manifest.migrationId, directoryDigest: directory.digest, snapshotRoot: root,
      sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision,
      recordsDigest: await hash(canonicalJson(records)), backupDigest: await hash(bytes), backupBytes: bytes.length,
      verifiedRecords, opaqueRecords,
    });
    check(); const signature = await signPrivateChange(access.signingPrivateKey, proof); check();
    return { proof, signature };
  } finally { key.fill(0); }
}
