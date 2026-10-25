import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BSON } from "mongodb";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { canonicalJson, deriveSecret, emptyRecoveryCollections, emptyRecoverySupplementCollections, fingerprint, recoveryDigest, recoverySupplementDigest, seal, signPrivateChange, unseal, verifyWorkspaceRecovery, verifyWorkspaceRecoverySupplement, type PublicKey } from "@starter/core";
import { RECOVERY_KINDS, RECOVERY_SUPPLEMENT_KINDS, RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS } from "@starter/shared";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { fenceWorkspace, withBusinessTransaction } from "../business-transaction.js";
import { privateProjectionPreparationReadiness } from "./projection-receipts.js";
import { workspaceRecovery } from "./recovery.js";
import { capturePrivateMigrationSupplement } from "./recovery-supplement.js";
import type { OriginalStageScope } from "./original-staging.js";
import { withOperatorRestoreSandbox } from "./operator-restore-sandbox.js";
import { verifyPrivateChange } from "./signatures.js";

const checkpoint = z.object({
  server: z.string().min(1).max(2048), workspaceId: z.string().min(1).max(100), ownerId: z.string().min(1).max(100),
  migrationId: z.string().uuid(), modeId: z.string().regex(/^[a-f0-9]{24}$/),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), snapshotRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/), createdAt: z.iso.datetime(),
});
const archiveSchema = checkpoint.extend({ format: z.literal("trackyourtime-operator-originals-v1"), snapshot: z.unknown(), supplement: z.unknown() }).strict();
const headerSchema = checkpoint.extend({ format: z.literal("trackyourtime-operator-backup-v1") }).strict();
const fileSchema = z.object({ header: headerSchema, box: z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(36 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/) }).strict() }).strict();
type Checkpoint = z.infer<typeof checkpoint>;
export type OperatorRecoveryScope = Omit<Checkpoint, "createdAt">;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const signedOperatorRecoveryProofSchema = z.object({ proof: checkpoint.omit({ createdAt: true }).extend({
  protocol: z.literal("trackyourtime-operator-backup-proof-v1"), v: z.literal(1),
  sourceRevision: hex, supplementRevision: hex, fileSha256: hex,
  operatorFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/), verifiedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).strict(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedOperatorRecoveryProof = z.infer<typeof signedOperatorRecoveryProofSchema>;
const verified = Symbol("verified-operator-recovery-file");
type VerifiedOperatorRecoveryFile = Readonly<OperatorRecoveryScope & { sourceRevision: string; supplementRevision: string; fileSha256: string; verifiedAt: number; [verified]: true }>;
const verifiedFiles = new WeakSet<object>();
export async function verifyOperatorRecoveryArchive(input: unknown, expected?: OperatorRecoveryScope) {
  const archive = archiveSchema.parse(structuredClone(input));
  const origin = new URL(archive.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== archive.server) throw new Error("Invalid operator backup origin");
  if (expected && Object.entries(expected).some(([key, value]) => archive[key as keyof typeof archive] !== value)) throw new Error("Operator backup checkpoint does not match");
  const snapshot = await verifyWorkspaceRecovery(archive.snapshot, archive.workspaceId);
  const supplement = await verifyWorkspaceRecoverySupplement(archive.supplement, archive.workspaceId);
  if (Buffer.byteLength(JSON.stringify(archive)) > RECOVERY_MAX_BYTES || [...Object.values(snapshot.collections), ...Object.values(supplement.collections)].reduce((sum, rows) => sum + rows.length, 0) > RECOVERY_MAX_RECORDS) throw new Error("Operator originals exceed recovery limits");
  return { ...archive, snapshot, supplement };
}
/** Privileged internal capture only. This includes ALL creators' originals,
 * unlike owner/member recovery files. Never return through a user API. No
 * activation or source retirement is authorized by creating this archive. */
export async function captureOperatorRecoveryArchive(inputScope: OriginalStageScope, expectedRoot: string) {
  const scope = { ...inputScope };
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    if ((await privateProjectionPreparationReadiness(scope, expectedRoot)).status !== "content-verified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Saved-file content verification is incomplete. Original data was kept." });
    const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId, migrationId: scope.migrationId, ownerId: scope.userId }).lean();
    if (!mode?.directoryDigest) throw new TRPCError({ code: "NOT_FOUND" });
    const snapshot = await workspaceRecovery(scope.workspaceId, scope.userId, true), supplement = await capturePrivateMigrationSupplement(scope.workspaceId, scope.userId);
    if (snapshot.sourceRevision !== mode.sourceRevision || supplement.sourceRevision !== mode.supplementRevision) throw new TRPCError({ code: "CONFLICT" });
    return verifyOperatorRecoveryArchive({ format: "trackyourtime-operator-originals-v1", server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, migrationId: scope.migrationId, modeId: String(mode._id), directoryDigest: mode.directoryDigest, snapshotRoot: expectedRoot, createdAt: new Date().toISOString(), snapshot, supplement });
  });
}
function scopeOf(header: Checkpoint): OperatorRecoveryScope {
  const { createdAt: _createdAt, ...scope } = checkpoint.parse(header); return scope;
}
async function purposeKey(independentKey: Uint8Array, scope: OperatorRecoveryScope) {
  if (independentKey.length !== 32) throw new Error("A separate random 256-bit operator key is required");
  return deriveSecret(independentKey, canonicalJson({ protocol: "trackyourtime-operator-backup-key-v1", ...scope }));
}
/** Execute on the trusted operator machine. Supply an independent random key
 * held off the application host; never use an account password/recovery key.
 * The key is not written or returned, and account private roots are not used. */
export async function encryptOperatorRecoveryArchive(input: unknown, independentKey: Uint8Array) {
  const archive = await verifyOperatorRecoveryArchive(input), { snapshot: _snapshot, supplement: _supplement, format: _format, ...metadata } = archive;
  const header = headerSchema.parse({ ...metadata, format: "trackyourtime-operator-backup-v1" });
  const raw = new Uint8Array(independentKey); let key: Uint8Array | undefined;
  try {
    key = await purposeKey(raw, scopeOf(header));
    return fileSchema.parse({ header, box: await seal(key, archive, canonicalJson(header)) });
  } finally { raw.fill(0); key?.fill(0); }
}
export async function openOperatorRecoveryArchive(input: unknown, independentKey: Uint8Array, expected: OperatorRecoveryScope) {
  const file = fileSchema.parse(input), raw = new Uint8Array(independentKey); let key: Uint8Array | undefined;
  try {
    const scope = scopeOf(file.header);
    if (canonicalJson(scope) !== canonicalJson(checkpoint.omit({ createdAt: true }).strict().parse(expected))) throw new Error("Operator backup checkpoint does not match");
    key = await purposeKey(raw, scope);
    const archive = await verifyOperatorRecoveryArchive(await unseal<unknown>(key, file.box, canonicalJson(file.header)), expected);
    if (archive.createdAt !== file.header.createdAt) throw new Error("Operator backup metadata does not match");
    return archive;
  } finally { raw.fill(0); key?.fill(0); }
}
/** Saved bytes must decrypt, then round-trip all seventeen original collections
 * in a freshly generated isolated database. Never writes to the source DB.
 * This drill checks typed documents, not indexes, account tables, external
 * files, post-cutover rollback or physical/process retirement. */
export async function verifyOperatorRecoveryCopy(input: unknown, independentKey: Uint8Array, inputScope: OperatorRecoveryScope, mongodPath: string) {
  const expected = checkpoint.omit({ createdAt: true }).strict().parse(inputScope);
  const archive = await openOperatorRecoveryArchive(input, independentKey, expected);
  return withOperatorRestoreSandbox(mongodPath, async (client) => {
    const name = `trackyourtime-operator-check-${crypto.randomUUID().replaceAll("-", "")}`, copy = client.db(name);
    if ((await copy.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error("Operator recovery destination already exists");
    try {
      const business = emptyRecoveryCollections(), supplement = emptyRecoverySupplementCollections();
      for (const kind of [...RECOVERY_KINDS, ...RECOVERY_SUPPLEMENT_KINDS]) {
        const rows = kind in business ? archive.snapshot.collections[kind as keyof typeof business] : archive.supplement.collections[kind as keyof typeof supplement];
        await copy.createCollection(kind);
        for (let offset = 0; offset < rows.length; offset += 100) await copy.collection(kind).insertMany(rows.slice(offset, offset + 100).map((row) => BSON.EJSON.deserialize(row, { relaxed: false })));
        const read = await copy.collection(kind).find({}, { promoteValues: false, promoteLongs: false }).collation({ locale: "simple" }).sort({ _id: 1 }).toArray();
        const typed = BSON.EJSON.serialize(read, { relaxed: false }) as Record<string, unknown>[];
        if (kind in business) business[kind as keyof typeof business] = typed;
        else supplement[kind as keyof typeof supplement] = typed;
      }
      if (await recoveryDigest(business) !== archive.snapshot.sourceRevision || await recoverySupplementDigest(supplement) !== archive.supplement.sourceRevision) throw new Error("Operator recovery copy differs from the original typed records");
      return { ...expected, sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision };
    } finally {
      try { await copy.dropDatabase(); } catch (cause) { throw new Error(`Operator recovery drill cleanup failed for ${name}`, { cause }); }
    }
  });
}
/** Operator-local file writer, never a network route. Exclusive 0600 creation
 * preserves existing backups. Only reopening the saved file and completing the
 * isolated drill returns success. Failures keep encrypted evidence and never
 * update a server-side "backup verified" flag or remove original records. */
export async function saveOperatorRecoveryCopy(path: string, input: unknown, independentKey: Uint8Array, mongodPath: string) {
  if (!isAbsolute(path)) throw new Error("Choose an absolute operator backup path");
  const archive = await verifyOperatorRecoveryArchive(input);
  const expected = scopeOf(archive), file = await encryptOperatorRecoveryArchive(archive, independentKey);
  const bytes = Buffer.from(JSON.stringify(file));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return verifySavedCopy(path, independentKey, expected, mongodPath, bytes);
}
/** Recheck an existing operator file after restart without overwriting it.
 * A restored JSON report is never treated as verification of saved bytes. */
export function verifySavedOperatorRecoveryCopy(path: string, independentKey: Uint8Array, expected: OperatorRecoveryScope, mongodPath: string) {
  return verifySavedCopy(path, independentKey, checkpoint.omit({ createdAt: true }).strict().parse(expected), mongodPath);
}
async function verifySavedCopy(path: string, independentKey: Uint8Array, expected: OperatorRecoveryScope, mongodPath: string, expectedBytes?: Buffer): Promise<VerifiedOperatorRecoveryFile> {
  if (!isAbsolute(path)) throw new Error("Choose an absolute operator backup path");
  const saved = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let read: Buffer;
  try {
    const stat = await saved.stat();
    if (!stat.isFile() || (expectedBytes && stat.size !== expectedBytes.length) || stat.size > 36 * 1024 * 1024) throw new Error("Operator backup readback size differs");
    read = await saved.readFile();
  } finally { await saved.close(); }
  if (expectedBytes && !read.equals(expectedBytes)) throw new Error("Operator backup readback differs");
  const checked = await verifyOperatorRecoveryCopy(JSON.parse(read.toString("utf8")), independentKey, expected, mongodPath);
  const result = Object.freeze({ ...checked, fileSha256: createHash("sha256").update(read).digest("hex"), verifiedAt: Date.now(), [verified]: true as const });
  verifiedFiles.add(result); return result;
}
/** Sign only a current in-process saved-file/readback/isolated-drill result.
 * JSON copies and caller-created "verified" objects are refused. Keep the
 * independent operator signing key off the application host too. */
export async function signOperatorRecoveryProof(file: VerifiedOperatorRecoveryFile, privateKey: PublicKey, publicKey: PublicKey): Promise<SignedOperatorRecoveryProof> {
  if (!verifiedFiles.has(file) || !Object.isFrozen(file)) throw new Error("A verified saved operator file is required");
  const now = Date.now();
  if (file.verifiedAt > now + 30_000 || file.verifiedAt < now - 300_000) throw new Error("Recheck the saved operator file before signing");
  const proof = signedOperatorRecoveryProofSchema.shape.proof.parse({ ...file, protocol: "trackyourtime-operator-backup-proof-v1", v: 1, expiresAt: file.verifiedAt + 3_600_000, operatorFingerprint: await fingerprint(publicKey) });
  const signature = await signPrivateChange(privateKey, proof);
  await verifyPrivateChange(publicKey, proof, signature);
  return signedOperatorRecoveryProofSchema.parse({ proof, signature });
}
