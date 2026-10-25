import { z } from "zod";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES, signedPrivateInitialSnapshotSchema, type EncryptedRecord, type SignedPrivateInitialSnapshot } from "@starter/shared";
import { canonicalJson, decodeSecret, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, readersForPrivateRecord } from "./records.js";
import { privateRecordDigest } from "./workspace-edits.js";
import type { PrivateStorageScope } from "./storage.js";

const encoder = new TextEncoder();
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
const verified = Symbol("verified-private-initial-snapshot");
const boundedRecords = z.array(encryptedRecordSchema).max(400_000);
type Secrets = { privateKey: PublicKey; signingPrivateKey: PublicKey };
export type VerifiedPrivateInitialSnapshot = {
  readonly [verified]: true;
  readonly signed: SignedPrivateInitialSnapshot;
  readonly records: readonly EncryptedRecord[];
  /** Captures the unlock generation, not just whether the device is unlocked. */
  readonly current: () => boolean;
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checkSize(value: unknown, max = PRIVATE_SNAPSHOT_MAX_BYTES): void {
  if (encoder.encode(JSON.stringify(value)).byteLength > max) throw new Error("Private initial snapshot is too large");
}
function orderedRecords(input: readonly unknown[]): EncryptedRecord[] {
  checkSize(input);
  const rows = boundedRecords.parse(input);
  rows.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
  let previous: string | null = null;
  for (const row of rows) {
    if (!row.keyCommitment) throw new Error("Initial private snapshots require committed record keys");
    if (row.revision !== 1 || previous === address(row)) throw new Error("Duplicate or unexpected initial snapshot record");
    previous = address(row);
  }
  return rows;
}
export function privateInitialSnapshotProjection(records: readonly EncryptedRecord[], userId: string): EncryptedRecord[] {
  return records.filter((row) => row.grants.some((grant) => grant.userId === userId)).map((row) => ({
    ...row, grants: row.grants.filter((grant) => grant.userId === userId),
  }));
}
/** A common signed root binds every reader projection to the same initial
 * history, while the complete ciphertext digest stays opaque to other readers. */
export function privateInitialSnapshotRoot(scope: { server: string; workspaceId: string; migrationId: string; directoryDigest: string }, recordsDigest: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(recordsDigest)) throw new Error("Invalid initial ciphertext digest");
  const { server, workspaceId, migrationId, directoryDigest } = scope;
  return privateRecordDigest({ protocol: "trackyourtime-private-initial-root-v1", server, workspaceId, migrationId, directoryDigest, recordsDigest });
}
/** Signs ciphertext already checked against the original recovery copy by the
 * migration proof. This signature proves delivery completeness, not conversion
 * correctness; it never replaces that separate source-content verification. */
export async function signPrivateInitialSnapshot(options: {
  records: readonly unknown[]; migrationId: string; userId: string;
  directory: VerifiedPrivateDirectory; secrets: Secrets; current: () => boolean;
}) {
  const records = orderedRecords(options.records);
  const { directory, userId, current } = options;
  const check = () => { if (!current()) throw new Error("Private snapshot changed during signing"); };
  check();
  const access = privateReplicaIdentityFromDirectory(directory, userId, options.secrets, current);
  const { server, workspaceId, ownerId } = directory.signed.directory;
  if (userId !== ownerId) throw new Error("Only the verified workspace owner can sign an initial snapshot");
  for (const row of records) {
    const expected = readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((member) => member.userId).sort();
    const actual = row.grants.map((grant) => grant.userId).sort();
    if (new Set(actual).size !== actual.length || canonicalJson(actual) !== canonicalJson(expected)) throw new Error("Initial snapshot recipients do not match the verified directory");
  }
  const readers: SignedPrivateInitialSnapshot[] = [];
  const root = await privateInitialSnapshotRoot({ server, workspaceId, migrationId: options.migrationId, directoryDigest: directory.digest }, await privateRecordDigest(records));
  for (const member of directory.signed.directory.members) {
    check();
    const projection = privateInitialSnapshotProjection(records, member.userId);
    const manifest = signedPrivateInitialSnapshotSchema.shape.manifest.parse({
      v: 1, protocol: "trackyourtime-private-initial-snapshot-v2", server, workspaceId, root,
      migrationId: options.migrationId, revision: 1, directoryDigest: directory.digest,
      signerId: userId, readerId: member.userId, recordCount: projection.length,
      recordsDigest: await privateRecordDigest(projection),
    });
    check();
    readers.push({ manifest, signature: await signPrivateChange(options.secrets.signingPrivateKey, manifest) });
  }
  check();
  return freeze({ records, readers });
}
async function verifiedManifest(input: unknown, scope: PrivateStorageScope, directory: VerifiedPrivateDirectory) {
  const signed = signedPrivateInitialSnapshotSchema.parse(input), { manifest } = signed;
  const owner = directory.signed.directory.members.find((member) => member.userId === directory.signed.directory.ownerId)!;
  if (manifest.server !== scope.server || manifest.workspaceId !== scope.workspaceId || manifest.readerId !== scope.userId || manifest.signerId !== owner.userId || manifest.directoryDigest !== directory.digest || directory.signed.directory.server !== scope.server || directory.signed.directory.workspaceId !== scope.workspaceId) throw new Error("Initial snapshot belongs to another account, directory or workspace");
  const key = await crypto.subtle.importKey("jwk", owner.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), encoder.encode(canonicalJson(manifest)))) throw new Error("Initial snapshot signature did not match");
  return signed;
}
export async function verifyPrivateInitialSnapshot(options: {
  signed: unknown; records: readonly unknown[]; scope: PrivateStorageScope;
  directory: VerifiedPrivateDirectory; secrets: Secrets; current: () => boolean;
}): Promise<VerifiedPrivateInitialSnapshot> {
  const { current, directory } = options;
  const scope = { ...options.scope };
  const check = () => { if (!current()) throw new Error("Private snapshot changed during verification"); };
  check();
  const access = privateReplicaIdentityFromDirectory(directory, scope.userId, options.secrets, current);
  // Clone/validate before awaiting. A transport cannot mutate data after its
  // signature was checked and before it becomes the durable local checkpoint.
  const records = orderedRecords(options.records);
  const signed = await verifiedManifest(options.signed, scope, directory); check();
  if (signed.manifest.recordCount !== records.length || await privateRecordDigest(records) !== signed.manifest.recordsDigest) throw new Error("Initial snapshot omitted or changed signed records");
  for (const row of records) {
    check();
    if (row.grants.length !== 1 || row.grants[0]!.userId !== scope.userId || !readersForPrivateRecord(row.kind, row.authorId, access.recipients).some((member) => member.userId === scope.userId)) throw new Error("Initial snapshot contains another member's private records");
    await decryptPrivateRecord(scope.workspaceId, row, scope.userId, access.privateKey);
  }
  check();
  return freeze({ [verified]: true as const, signed, records, current });
}
/** Runtime guard for the replica. JSON/API objects cannot manufacture the
 * verification brand or resume a receipt from an earlier unlock generation. */
export function assertPrivateInitialSnapshot(value: VerifiedPrivateInitialSnapshot, scope: PrivateStorageScope, directoryDigest: string): void {
  if (value?.[verified] !== true || !value.current() || value.signed.manifest.server !== scope.server || value.signed.manifest.workspaceId !== scope.workspaceId || value.signed.manifest.readerId !== scope.userId || value.signed.manifest.directoryDigest !== directoryDigest) throw new Error("A current verified initial snapshot is required");
}
export type PrivateInitialSnapshotTransport = {
  manifest: () => Promise<unknown>;
  page: (input: { migrationId: string; offset: number }) => Promise<{ offset: number; next: number | null; records: unknown[] }>;
};
/** Accumulate bounded immutable pages, then authenticate the complete reader
 * projection. No partial download is a checkpoint. A fixed signed count/hash
 * rejects missing, replaced, duplicated or mixed pages before installation. */
export async function downloadPrivateInitialSnapshot(options: Omit<Parameters<typeof verifyPrivateInitialSnapshot>[0], "signed" | "records"> & { transport: PrivateInitialSnapshotTransport }): Promise<VerifiedPrivateInitialSnapshot> {
  const { current, directory, secrets, transport } = options;
  const scope = { ...options.scope };
  const check = () => { if (!current()) throw new Error("Private snapshot changed during download"); };
  check();
  privateReplicaIdentityFromDirectory(directory, scope.userId, secrets, current);
  const signed = await verifiedManifest(await transport.manifest(), scope, directory); check();
  const records: unknown[] = [];
  let offset = 0, bytes = 2;
  while (offset < signed.manifest.recordCount) {
    const page = await transport.page({ migrationId: signed.manifest.migrationId, offset }); check();
    checkSize(page, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES);
    if (page.offset !== offset || !Array.isArray(page.records) || !page.records.length || page.records.length > 100 || offset + page.records.length > signed.manifest.recordCount) throw new Error("Invalid initial snapshot page");
    const copied = boundedRecords.parse(page.records);
    bytes += encoder.encode(JSON.stringify(copied)).byteLength;
    if (bytes > PRIVATE_SNAPSHOT_MAX_BYTES) throw new Error("Private initial snapshot is too large");
    records.push(...copied); offset += copied.length;
    if (page.next !== (offset < signed.manifest.recordCount ? offset : null)) throw new Error("Initial snapshot page omitted records");
  }
  return verifyPrivateInitialSnapshot({ current, directory, secrets, scope, signed, records });
}
