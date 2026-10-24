import { z } from "zod";
import { encryptedRecordSchema, type EncryptedRecord, type WorkspaceRecovery } from "@starter/shared";
import { canonicalJson, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, partitionPrivateRecovery, readersForPrivateRecord } from "./records.js";
import { verifyWorkspaceRecovery } from "./recovery.js";
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
