import { z } from "zod";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_USER_ONLY_KINDS, privateInitialProjectionRootSchema, signedPrivateInitialProjectionRootSchema, type EncryptedRecord, type SignedPrivateInitialProjectionRoot } from "@starter/shared";
import { canonicalJson, decodeSecret, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { decryptPrivateRecord, readersForPrivateRecord } from "./records.js";
import { privateInitialSnapshotProjection } from "./initial-snapshot.js";
import { privateRecordDigest } from "./workspace-edits.js";
import type { PrivateStorageScope } from "./storage.js";
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
const personal = (kind: string) => (PRIVATE_USER_ONLY_KINDS as readonly string[]).includes(kind);
const verified = Symbol("verified-private-projection-snapshot");
type Secrets = { privateKey: PublicKey; signingPrivateKey: PublicKey };
export type VerifiedPrivateProjectionSnapshot = {
  readonly [verified]: true; readonly signed: SignedPrivateInitialProjectionRoot; readonly root: string;
  readonly scope: PrivateStorageScope; readonly sharedRecords: readonly EncryptedRecord[];
  readonly personalRecords: readonly EncryptedRecord[]; readonly current: () => boolean;
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function rows(input: readonly unknown[], privateRows: boolean): EncryptedRecord[] {
  if (new TextEncoder().encode(JSON.stringify(input)).length > PRIVATE_SNAPSHOT_MAX_BYTES) throw new Error("Initial projection exceeds its size bound");
  const output = z.array(encryptedRecordSchema).max(400_000).parse(input);
  output.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
  let last: string | null = null;
  for (const row of output) {
    if (row.revision !== 1 || !row.keyCommitment || personal(row.kind) !== privateRows || address(row) === last) throw new Error("Invalid initial projection record, namespace or key binding");
    last = address(row);
  }
  return output;
}
function checkRoot(input: SignedPrivateInitialProjectionRoot["manifest"], directory: VerifiedPrivateDirectory, scope: Pick<PrivateStorageScope, "server" | "workspaceId">) {
  const root = privateInitialProjectionRootSchema.parse(input), expected = directory.signed.directory;
  if (new URL(root.server).origin !== root.server || !["https:", "http:"].includes(new URL(root.server).protocol) || root.server !== scope.server || root.workspaceId !== scope.workspaceId || root.server !== expected.server || root.workspaceId !== expected.workspaceId || root.directoryDigest !== directory.digest || root.signerId !== expected.ownerId || canonicalJson(root.readers.map((row) => row.userId)) !== canonicalJson(expected.members.map((row) => row.userId))) throw new Error("Initial projection root differs from the verified workspace directory");
  return root;
}
/** Compute every shared-reader digest locally from owner-visible shared
 * ciphertext and full recipient grants. Never sign arbitrary shared digests
 * supplied by the server. Other creators supply opaque personal digests only.
 * Source-content/saved-file approval remains a separate required proof. */
export async function signPrivateInitialProjectionRoot(options: {
  sharedRecords: readonly unknown[]; ownerPersonalRecords: readonly unknown[]; personalDigests: ReadonlyMap<string, string>;
  migrationId: string; directory: VerifiedPrivateDirectory; userId: string; secrets: Secrets; current: () => boolean;
}): Promise<SignedPrivateInitialProjectionRoot> {
  const { directory, userId, secrets, current, migrationId } = options;
  const check = () => { if (!current()) throw new Error("Private projection changed during signing"); };
  check(); const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  const { server, workspaceId, ownerId, members } = directory.signed.directory;
  if (ownerId !== userId) throw new Error("Only the verified owner can sign initial projections");
  const sharedRecords = rows(options.sharedRecords, false), ownerPersonalRecords = rows(options.ownerPersonalRecords, true), personalDigests = new Map(options.personalDigests);
  if (sharedRecords.length + ownerPersonalRecords.length > 400_000 || new TextEncoder().encode(JSON.stringify([sharedRecords, ownerPersonalRecords])).length > PRIVATE_SNAPSHOT_MAX_BYTES) throw new Error("Initial projection exceeds its size bound");
  if (canonicalJson([...personalDigests.keys()].sort()) !== canonicalJson(members.map((row) => row.userId))) throw new Error("Every verified reader needs one personal commitment");
  for (const row of sharedRecords) {
    const audience = readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((m) => m.userId).sort();
    const actual = row.grants.map((grant) => grant.userId).sort();
    if (!audience.includes(userId) || new Set(actual).size !== actual.length || canonicalJson(actual) !== canonicalJson(audience)) throw new Error("Shared recipients differ from the verified directory");
    await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); check();
  }
  for (const row of ownerPersonalRecords) {
    if (row.authorId !== userId || row.grants.length !== 1 || row.grants[0]!.userId !== userId) throw new Error("Another creator's personal record was exposed to the owner");
    await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); check();
  }
  if (personalDigests.get(userId) !== await privateRecordDigest(ownerPersonalRecords)) throw new Error("Owner personal commitment differs from verified ciphertext");
  check();
  const readers = [];
  for (const member of members) {
    readers.push({ userId: member.userId, sharedDigest: await privateRecordDigest(privateInitialSnapshotProjection(sharedRecords, member.userId)), personalDigest: personalDigests.get(member.userId)! }); check();
  }
  const manifest = checkRoot({ v: 1, protocol: "trackyourtime-private-initial-projections-v3", server, workspaceId, migrationId, revision: 1, directoryDigest: directory.digest, signerId: userId, readers }, directory, { server, workspaceId });
  const signature = await signPrivateChange(access.signingPrivateKey, manifest); check();
  return { manifest, signature };
}
/** Verify exact shared and personal projections independently against one
 * owner-signed root. No other reader's personal IDs/counts are needed. */
export async function verifyPrivateInitialProjection(options: {
  signed: unknown; sharedRecords: readonly unknown[]; personalRecords: readonly unknown[];
  scope: PrivateStorageScope; directory: VerifiedPrivateDirectory; secrets: Secrets; current: () => boolean;
}): Promise<VerifiedPrivateProjectionSnapshot> {
  const { directory, secrets, current } = options, scope = structuredClone(options.scope);
  const check = () => { if (!current()) throw new Error("Private projection changed during verification"); };
  check(); const access = privateReplicaIdentityFromDirectory(directory, scope.userId, secrets, current);
  const signed = signedPrivateInitialProjectionRootSchema.parse(options.signed), manifest = checkRoot(signed.manifest, directory, scope);
  const sharedRecords = rows(options.sharedRecords, false), personalRecords = rows(options.personalRecords, true);
  if (sharedRecords.length + personalRecords.length > 400_000 || new TextEncoder().encode(JSON.stringify([sharedRecords, personalRecords])).length > PRIVATE_SNAPSHOT_MAX_BYTES) throw new Error("Initial projection exceeds its size bound");
  const owner = directory.signed.directory.members.find((member) => member.userId === manifest.signerId)!;
  const key = await crypto.subtle.importKey("jwk", owner.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(manifest)))) throw new Error("Initial projection root signature does not match the verified owner");
  check(); const own = manifest.readers.find((reader) => reader.userId === scope.userId);
  if (!own || own.sharedDigest !== await privateRecordDigest(sharedRecords) || own.personalDigest !== await privateRecordDigest(personalRecords)) throw new Error("Initial projection is incomplete or differs from its signed root");
  check();
  for (const row of [...sharedRecords, ...personalRecords]) {
    if (row.grants.length !== 1 || row.grants[0]!.userId !== scope.userId || (personal(row.kind) && row.authorId !== scope.userId) || !readersForPrivateRecord(row.kind, row.authorId, access.recipients).some((member) => member.userId === scope.userId)) throw new Error("Initial projection belongs to another reader or audience");
    await decryptPrivateRecord(scope.workspaceId, row, scope.userId, access.privateKey); check();
  }
  const root = await privateRecordDigest(manifest); check();
  return freeze({ [verified]: true as const, signed, root, scope, sharedRecords, personalRecords, current });
}

export function assertPrivateProjectionSnapshot(value: VerifiedPrivateProjectionSnapshot, scope: PrivateStorageScope, directoryDigest: string): void {
  if (value?.[verified] !== true || !value.current() || value.scope.server !== scope.server || value.scope.workspaceId !== scope.workspaceId || value.scope.userId !== scope.userId || value.signed.manifest.directoryDigest !== directoryDigest) throw new Error("Use the current verified private projection snapshot");
}
