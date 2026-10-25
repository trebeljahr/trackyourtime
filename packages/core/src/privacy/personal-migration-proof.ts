import { PRIVATE_USER_ONLY_KINDS, RECOVERY_KINDS, privatePersonalMigrationProofSchema, type CombinedWorkspaceRecoveryArchive, type SignedPrivatePersonalMigrationProof } from "@starter/shared";
import { canonicalJson, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, partitionPrivateRecovery } from "./records.js";
import { partitionPrivateRecoverySupplement } from "./recovery-supplement.js";
import { assertPrivateInitialSnapshot, type VerifiedPrivateInitialSnapshot } from "./initial-snapshot.js";
import { verifyCombinedRecoveryKeyBackup } from "./combined-recovery-backup.js";

const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** The same v2 encrypted container can hold a member's private subset. Such a
 * file must contain no shared originals or another creator's private data. */
export function assertPersonalMigrationArchive(archive: CombinedWorkspaceRecoveryArchive): void {
  if (RECOVERY_KINDS.some((kind) => kind !== "favorites" && archive.snapshot.collections[kind].length) || archive.supplement.collections.organization.length) throw new Error("A personal migration backup must contain only this account's favorites and integrations");
}
/** No complete workspace ciphertext or other creator's IDs are passed to this
 * member check. The verified reader projection supplies its own private subset.
 * The receipt is temporary and cannot authorize source deletion by itself. */
export async function createPrivatePersonalMigrationProof(options: {
  readBackup: () => Promise<string>; backupKey: Uint8Array;
  snapshot: VerifiedPrivateInitialSnapshot; directory: VerifiedPrivateDirectory;
  userId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivatePersonalMigrationProof> {
  const { snapshot, directory, userId, secrets, current } = options;
  const { server, workspaceId } = directory.signed.directory;
  const check = () => {
    if (!current()) throw new Error("Private migration changed during personal backup verification");
    assertPrivateInitialSnapshot(snapshot, { server, workspaceId, userId }, directory.digest);
  };
  check(); const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  const key = new Uint8Array(options.backupKey);
  try {
    const raw = await options.readBackup(); check();
    if (typeof raw !== "string" || !raw.length || raw.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted personal backup file");
    const bytes = new TextEncoder().encode(raw);
    if (bytes.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted personal backup file");
    const archive = await verifyCombinedRecoveryKeyBackup(JSON.parse(raw), key, { server, ownerId: userId, workspaceId }); check();
    assertPersonalMigrationArchive(archive);
    const originals = [...partitionPrivateRecovery(archive.snapshot), ...partitionPrivateRecoverySupplement(archive.supplement)];
    if (originals.some((row) => row.authorId !== userId)) throw new Error("Personal migration source belongs to another account");
    const expected = new Map(originals.map((row) => [address(row), row]));
    const records = snapshot.records.filter((row) => (PRIVATE_USER_ONLY_KINDS as readonly string[]).includes(row.kind));
    if (records.length !== expected.size) throw new Error("Encrypted personal records differ from the saved originals");
    for (const record of records) {
      check();
      if (record.authorId !== userId || record.grants.length !== 1 || record.grants[0]!.userId !== userId) throw new Error("Encrypted personal records belong to another account");
      const original = expected.get(address(record));
      const plain = await decryptPrivateRecord(workspaceId, record, userId, access.privateKey); check();
      if (!original || canonicalJson(original) !== canonicalJson(plain)) throw new Error("Encrypted personal records differ from the saved originals");
      expected.delete(address(record));
    }
    if (expected.size) throw new Error("Encrypted personal records are missing originals");
    const proof = privatePersonalMigrationProofSchema.parse({
      v: 1, protocol: "trackyourtime-private-personal-proof-v1", server, workspaceId, userId,
      migrationId: snapshot.signed.manifest.migrationId, directoryDigest: directory.digest, snapshotRoot: snapshot.signed.manifest.root,
      sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision,
      recordsDigest: await hash(canonicalJson(records)), backupDigest: await hash(bytes), backupBytes: bytes.length, verifiedRecords: records.length,
    });
    check(); const signature = await signPrivateChange(access.signingPrivateKey, proof); check();
    return { proof, signature };
  } finally { key.fill(0); }
}
