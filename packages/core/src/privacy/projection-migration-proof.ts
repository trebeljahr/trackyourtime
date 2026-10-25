import { privateProjectionOwnerProofSchema, privateProjectionPersonalProofSchema, signedPrivateProjectionOwnerProofSchema, signedPrivateProjectionPersonalProofSchema, type SignedPrivateProjectionOwnerProof, type SignedPrivateProjectionPersonalProof } from "@starter/shared";
import { canonicalJson, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, partitionPrivateRecovery } from "./records.js";
import { partitionPrivateRecoverySupplement } from "./recovery-supplement.js";
import { verifyCombinedRecoveryKeyBackup } from "./combined-recovery-backup.js";
import { assertPersonalMigrationArchive } from "./personal-migration-proof.js";
import { assertPrivateProjectionSnapshot, type VerifiedPrivateProjectionSnapshot } from "./projection-snapshot.js";
type Options = {
  readBackup: () => Promise<string>; backupKey: Uint8Array; snapshot: VerifiedPrivateProjectionSnapshot;
  directory: VerifiedPrivateDirectory; userId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
};
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Owner approval uses only the owner's verified shared/personal projections;
 * no complete opaque ciphertext archive or another creator's IDs is needed. */
export async function createPrivateProjectionOwnerProof(options: Options): Promise<SignedPrivateProjectionOwnerProof> {
  return signedPrivateProjectionOwnerProofSchema.parse(await createContentProof(options, true));
}
/** Personal approval covers only this creator's saved favorites/integrations.
 * It does not claim to verify that member's shared workspace originals. */
export async function createPrivateProjectionPersonalProof(options: Options): Promise<SignedPrivateProjectionPersonalProof> {
  return signedPrivateProjectionPersonalProofSchema.parse(await createContentProof(options, false));
}
async function createContentProof(options: Options, owner: boolean) {
  const { directory, userId, snapshot, secrets, current } = options;
  const { server, workspaceId, ownerId } = directory.signed.directory;
  const check = () => {
    if (!current()) throw new Error("Private projection changed during saved-file verification");
    assertPrivateProjectionSnapshot(snapshot, { server, workspaceId, userId }, directory.digest);
  };
  check(); const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  if (owner && ownerId !== userId) throw new Error("Only the verified owner can approve the shared source");
  const records = [...(owner ? snapshot.sharedRecords : []), ...snapshot.personalRecords].sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
  const key = new Uint8Array(options.backupKey);
  try {
    const raw = await options.readBackup(); check();
    if (typeof raw !== "string" || !raw.length || raw.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const bytes = new TextEncoder().encode(raw);
    if (bytes.length > 36 * 1024 * 1024) throw new Error("Invalid encrypted original backup file");
    const archive = await verifyCombinedRecoveryKeyBackup(JSON.parse(raw), key, { server, ownerId: userId, workspaceId }); check();
    if (!owner) assertPersonalMigrationArchive(archive);
    const originals = [...partitionPrivateRecovery(archive.snapshot), ...partitionPrivateRecoverySupplement(archive.supplement)];
    const expected = new Map(originals.map((row) => [address(row), row]));
    if (records.length !== expected.size) throw new Error("Saved originals differ from the verified projection snapshot");
    for (const record of records) {
      const original = expected.get(address(record));
      const plain = await decryptPrivateRecord(workspaceId, record, userId, access.privateKey); check();
      if (!original || canonicalJson(plain) !== canonicalJson(original)) throw new Error("Saved originals differ from the verified projection snapshot");
      expected.delete(address(record));
    }
    if (expected.size) throw new Error("Verified projection is missing saved originals");
    const fields = {
      server, workspaceId, userId, migrationId: snapshot.signed.manifest.migrationId, directoryDigest: directory.digest,
      snapshotRoot: snapshot.root, sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision,
      recordsDigest: await hash(canonicalJson(records)), backupDigest: await hash(bytes), backupBytes: bytes.length, verifiedRecords: records.length,
    };
    const proof = owner
      ? privateProjectionOwnerProofSchema.parse({ ...fields, v: 3, protocol: "trackyourtime-private-owner-proof-v3" })
      : privateProjectionPersonalProofSchema.parse({ ...fields, v: 2, protocol: "trackyourtime-private-personal-proof-v2" });
    check(); const signature = await signPrivateChange(access.signingPrivateKey, proof); check();
    return { proof, signature };
  } finally { key.fill(0); }
}
