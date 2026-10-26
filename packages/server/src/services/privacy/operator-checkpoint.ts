import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import mongoose from "mongoose";
import { BSON } from "mongodb";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { canonicalJson, deriveSecret, fingerprint, seal, signPrivateChange, unseal, type PublicKey } from "@starter/core";
import { RECOVERY_KINDS, RECOVERY_SUPPLEMENT_KINDS, RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, signedPrivatePreparationReservationSchema, type SignedPrivatePreparationReservation } from "@starter/shared";
import { beforeBusinessCommit, fenceWorkspace, transactionSession, withBusinessTransaction } from "../business-transaction.js";
import { PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { captureOperatorRecoveryArchive, verifyOperatorRecoveryArchive, type OperatorRecoveryScope } from "./operator-recovery.js";
import { withOperatorRestoreSandbox } from "./operator-restore-sandbox.js";
import { verifyPrivateChange } from "./signatures.js";
import type { OriginalStageScope } from "./original-staging.js";
import { requireActivePrivatePreparation } from "./preparation.js";

/** Workspace-scoped frozen artifacts only. Account/auth data, installation
 * indexes/files, quota rebuild and post-cutover rollback are separate duties. */
export const OPERATOR_CHECKPOINT_COLLECTIONS = ["privateworkspaces", "privatedirectories", "privaterecords", "privatesnapshotchunks", "privatesnapshotreaders", "privateprojectionroots", "privateprojectionreaders", "privatemigrationreceipts"] as const;
const hex = z.string().regex(/^[a-f0-9]{64}$/), digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const scopeSchema = z.object({ server: z.string().min(1).max(2048), workspaceId: z.string().min(1).max(100), ownerId: z.string().min(1).max(100), migrationId: z.uuid(), modeId: z.string().regex(/^[a-f0-9]{24}$/), directoryDigest: digest, snapshotRoot: digest }).strict();
const typedRows = z.array(z.record(z.string(), z.unknown())).max(RECOVERY_MAX_RECORDS);
const controlsSchema = z.object({ privateworkspaces: typedRows, privatedirectories: typedRows, privaterecords: typedRows, privatesnapshotchunks: typedRows, privatesnapshotreaders: typedRows, privateprojectionroots: typedRows, privateprojectionreaders: typedRows, privatemigrationreceipts: typedRows }).strict();
const archiveSchema = z.object({ format: z.literal("trackyourtime-operator-checkpoint-v1"), originals: z.unknown(), controls: controlsSchema, controlsDigest: hex, reservation: signedPrivatePreparationReservationSchema.nullable().default(null) }).strict();
const headerSchema = scopeSchema.extend({ format: z.literal("trackyourtime-operator-checkpoint-file-v1"), createdAt: z.iso.datetime(), controlsDigest: hex, reservationDigest: hex.nullable().optional() }).strict();
const fileSchema = z.object({ header: headerSchema, box: z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(36 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/) }).strict() }).strict();
export const signedOperatorCheckpointProofSchema = z.object({ proof: scopeSchema.extend({ protocol: z.literal("trackyourtime-operator-checkpoint-proof-v1"), v: z.literal(1), sourceRevision: hex, supplementRevision: hex, controlsDigest: hex, reservationDigest: hex.nullable().optional(), fileSha256: hex, operatorFingerprint: digest, verifiedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).strict(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedOperatorCheckpointProof = z.infer<typeof signedOperatorCheckpointProofSchema>;
const verifiedFiles = new WeakSet<object>();
type VerifiedFile = Readonly<OperatorRecoveryScope & { sourceRevision: string; supplementRevision: string; controlsDigest: string; reservationDigest: string | null; fileSha256: string; verifiedAt: number }>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function bounds(value: unknown) { if (Buffer.byteLength(JSON.stringify(value)) > RECOVERY_MAX_BYTES) throw new Error("Operator checkpoint exceeds its supported size. Original data was kept."); }
function scopeOf(input: unknown) {
  const scope = scopeSchema.parse(input), origin = new URL(scope.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== scope.server) throw new Error("Invalid operator checkpoint origin");
  return scope;
}
const checkpointOf = (input: OperatorRecoveryScope) => scopeOf(Object.fromEntries(Object.keys(scopeSchema.shape).map((key) => [key, input[key as keyof OperatorRecoveryScope]])));
export async function verifyOperatorCheckpointArchive(input: unknown, expected?: OperatorRecoveryScope) {
  bounds(input); const archive = archiveSchema.parse(structuredClone(input));
  const originals = await verifyOperatorRecoveryArchive(archive.originals, expected), scope = checkpointOf(originals);
  if (hash(archive.controls) !== archive.controlsDigest) throw new Error("Operator checkpoint artifacts differ from their digest");
  let count = [...Object.values(originals.snapshot.collections), ...Object.values(originals.supplement.collections)].reduce((sum, rows) => sum + rows.length, 0);
  const decoded = (kind: typeof OPERATOR_CHECKPOINT_COLLECTIONS[number]) => archive.controls[kind].map((row) => BSON.EJSON.deserialize(row, { relaxed: false }) as Record<string, unknown>);
  for (const kind of OPERATOR_CHECKPOINT_COLLECTIONS) {
    const ids = new Set<string>(); count += archive.controls[kind].length;
    if (count > RECOVERY_MAX_RECORDS) throw new Error("Operator checkpoint exceeds its record limit. Original data was kept.");
    for (const row of decoded(kind)) {
      if (row.workspaceId !== scope.workspaceId || row._id === undefined || (kind !== "privateworkspaces" && kind !== "privatedirectories" && kind !== "privaterecords" && row.migrationId !== scope.migrationId)) throw new Error("Operator checkpoint contains artifacts from another scope");
      const id = canonicalJson(BSON.EJSON.serialize(row._id, { relaxed: false }));
      if (ids.has(id)) throw new Error("Duplicate operator checkpoint artifact"); ids.add(id);
    }
  }
  const modes = decoded("privateworkspaces"), roots = decoded("privateprojectionroots");
  const mode = modes[0], root = roots[0];
  if (modes.length !== 1 || !mode || String(mode._id) !== scope.modeId || mode.ownerId !== scope.ownerId || mode.migrationId !== scope.migrationId || mode.state !== "migrating" || Number(mode.revision) !== 0 || mode.head !== null || mode.backupVerified !== false || mode.directoryDigest !== scope.directoryDigest || mode.sourceRevision !== originals.snapshot.sourceRevision || mode.supplementRevision !== originals.supplement.sourceRevision) throw new Error("Operator checkpoint preparation does not match");
  if (roots.length !== 1 || !root || root.root !== scope.snapshotRoot) throw new Error("Operator checkpoint initial root does not match");
  if (!archive.controls.privatedirectories.length || !archive.controls.privateprojectionreaders.length || archive.controls.privatesnapshotreaders.length) throw new Error("Operator checkpoint frozen artifacts are incomplete");
  if (archive.reservation) {
    const { request, signature } = archive.reservation;
    if (request.server !== scope.server || request.workspaceId !== scope.workspaceId || request.userId !== scope.ownerId || request.migrationId !== scope.migrationId || request.modeId !== scope.modeId || request.directoryDigest !== scope.directoryDigest || request.snapshotRoot !== scope.snapshotRoot) throw new Error("Operator checkpoint reservation consent does not match");
    const latest = decoded("privatedirectories").find((row) => row.digest === scope.directoryDigest) as { signed?: { directory?: { members?: { userId: string; signingPublicKey: PublicKey }[] } } } | undefined;
    const owner = latest?.signed?.directory?.members?.find((member) => member.userId === scope.ownerId);
    if (!owner || owner.signingPublicKey.d) throw new Error("Operator checkpoint reservation signing key is missing");
    await verifyPrivateChange(owner.signingPublicKey, request, signature);
  }
  return { ...archive, originals };
}
/** Privileged internal capture after content receipts, in the same workspace
 * snapshot as all originals. Never expose another member's artifacts to an
 * owner API. The frozen preparation is still disposable until reservation. */
export async function captureOperatorCheckpointArchive(inputScope: OriginalStageScope, expectedRoot: string, inputConsent: SignedPrivatePreparationReservation | null = null) {
  const scope = { ...inputScope }, reservation = inputConsent ? signedPrivatePreparationReservationSchema.parse(inputConsent) : null;
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const originals = await captureOperatorRecoveryArchive(scope, expectedRoot);
    if (await PrivateWorkspaceCommit.exists({ workspaceId: scope.workspaceId })) throw new Error("Unexpected committed private history; checkpoint was not captured");
    const db = mongoose.connection.db; if (!db) throw new Error("Database unavailable");
    const controls = controlsSchema.parse(Object.fromEntries(OPERATOR_CHECKPOINT_COLLECTIONS.map((kind) => [kind, []])));
    let bytes = Buffer.byteLength(JSON.stringify(originals));
    for (const kind of OPERATOR_CHECKPOINT_COLLECTIONS) {
      const cursor = db.collection(kind).find({ workspaceId: scope.workspaceId }, { session: transactionSession(), promoteValues: false, promoteLongs: false }).collation({ locale: "simple" }).sort({ _id: 1 });
      try {
        for await (const row of cursor) {
          const typed = BSON.EJSON.serialize(row, { relaxed: false }) as Record<string, unknown>;
          bytes += Buffer.byteLength(JSON.stringify(typed)) + 1;
          if (bytes > RECOVERY_MAX_BYTES || controls[kind].length >= RECOVERY_MAX_RECORDS) throw new Error("Operator checkpoint exceeds its supported size. Original data was kept.");
          controls[kind].push(typed);
        }
      } finally { await cursor.close(); }
    }
    return verifyOperatorCheckpointArchive({ format: "trackyourtime-operator-checkpoint-v1", originals, controls, controlsDigest: hash(controls), reservation });
  });
}
async function keyFor(raw: Uint8Array, scope: OperatorRecoveryScope) {
  if (raw.length !== 32) throw new Error("A separate random 256-bit operator key is required");
  return deriveSecret(raw, canonicalJson({ protocol: "trackyourtime-operator-checkpoint-key-v1", ...scope }));
}
export async function encryptOperatorCheckpointArchive(input: unknown, independentKey: Uint8Array) {
  const raw = new Uint8Array(independentKey); let key: Uint8Array | undefined;
  try {
    const archive = await verifyOperatorCheckpointArchive(input), scope = checkpointOf(archive.originals);
    const header = headerSchema.parse({ ...scope, format: "trackyourtime-operator-checkpoint-file-v1", createdAt: archive.originals.createdAt, controlsDigest: archive.controlsDigest, reservationDigest: archive.reservation ? hash(archive.reservation.request) : null });
    key = await keyFor(raw, scope);
    return fileSchema.parse({ header, box: await seal(key, archive, canonicalJson(header)) });
  } finally { raw.fill(0); key?.fill(0); }
}
export async function openOperatorCheckpointArchive(input: unknown, independentKey: Uint8Array, expected: OperatorRecoveryScope) {
  const file = fileSchema.parse(input), scope = checkpointOf(file.header), raw = new Uint8Array(independentKey); let key: Uint8Array | undefined;
  try {
    if (canonicalJson(scope) !== canonicalJson(checkpointOf(expected))) throw new Error("Operator checkpoint belongs to another preparation");
    key = await keyFor(raw, scope);
    const archive = await verifyOperatorCheckpointArchive(await unseal<unknown>(key, file.box, canonicalJson(file.header)), scope);
    if (archive.controlsDigest !== file.header.controlsDigest || archive.originals.createdAt !== file.header.createdAt || (archive.reservation ? hash(archive.reservation.request) : null) !== (file.header.reservationDigest ?? null)) throw new Error("Operator checkpoint header differs from its archive");
    return archive;
  } finally { raw.fill(0); key?.fill(0); }
}
/** Restores the exact typed originals AND frozen cipher/control rows into a
 * separate authenticated process, then compares every row. No source writes,
 * caller-selected destination, activation or production rollback is provided. */
export async function verifyOperatorCheckpointCopy(input: unknown, independentKey: Uint8Array, expected: OperatorRecoveryScope, mongodPath: string) {
  const archive = await openOperatorCheckpointArchive(input, independentKey, expected);
  return withOperatorRestoreSandbox(mongodPath, async (client) => {
    const db = client.db(`tyt-operator-checkpoint-${crypto.randomUUID().replaceAll("-", "")}`);
    try {
      const collections = { ...archive.originals.snapshot.collections, ...archive.originals.supplement.collections, ...archive.controls };
      for (const kind of [...RECOVERY_KINDS, ...RECOVERY_SUPPLEMENT_KINDS, ...OPERATOR_CHECKPOINT_COLLECTIONS]) {
        const rows = collections[kind]; await db.createCollection(kind);
        for (let offset = 0; offset < rows.length; offset += 100) await db.collection(kind).insertMany(rows.slice(offset, offset + 100).map((row) => BSON.EJSON.deserialize(row, { relaxed: false })));
        const restored = await db.collection(kind).find({}, { promoteValues: false, promoteLongs: false }).collation({ locale: "simple" }).sort({ _id: 1 }).toArray();
        if (hash(BSON.EJSON.serialize(restored, { relaxed: false })) !== hash(rows)) throw new Error("Operator checkpoint restore differs from the saved typed artifacts");
      }
      return { ...checkpointOf(archive.originals), sourceRevision: archive.originals.snapshot.sourceRevision, supplementRevision: archive.originals.supplement.sourceRevision, controlsDigest: archive.controlsDigest, reservationDigest: archive.reservation ? hash(archive.reservation.request) : null };
    } finally { await db.dropDatabase(); }
  });
}
export async function saveOperatorCheckpointCopy(path: string, input: unknown, independentKey: Uint8Array, mongodPath: string) {
  if (!isAbsolute(path)) throw new Error("Choose an absolute operator checkpoint path");
  const archive = await verifyOperatorCheckpointArchive(input), expected = checkpointOf(archive.originals), file = await encryptOperatorCheckpointArchive(archive, independentKey), bytes = Buffer.from(JSON.stringify(file));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return verifySavedCopy(path, independentKey, expected, mongodPath, bytes);
}
export function verifySavedOperatorCheckpointCopy(path: string, independentKey: Uint8Array, expected: OperatorRecoveryScope, mongodPath: string) {
  return verifySavedCopy(path, independentKey, checkpointOf(expected), mongodPath);
}
async function verifySavedCopy(path: string, independentKey: Uint8Array, expected: OperatorRecoveryScope, mongodPath: string, expectedBytes?: Buffer): Promise<VerifiedFile> {
  if (!isAbsolute(path)) throw new Error("Choose an absolute operator checkpoint path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 36 * 1024 * 1024 || (expectedBytes && stat.size !== expectedBytes.length)) throw new Error("Operator checkpoint readback size differs");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (expectedBytes && !bytes.equals(expectedBytes)) throw new Error("Operator checkpoint readback differs");
  const restored = await verifyOperatorCheckpointCopy(JSON.parse(bytes.toString("utf8")), independentKey, expected, mongodPath);
  const result = Object.freeze({ ...restored, fileSha256: createHash("sha256").update(bytes).digest("hex"), verifiedAt: Date.now() });
  verifiedFiles.add(result); return result;
}
export async function signOperatorCheckpointProof(file: VerifiedFile, privateKey: PublicKey, publicKey: PublicKey): Promise<SignedOperatorCheckpointProof> {
  if (!verifiedFiles.has(file) || !Object.isFrozen(file) || file.verifiedAt > Date.now() + 30_000 || file.verifiedAt < Date.now() - 300_000) throw new Error("A current verified saved operator checkpoint is required");
  const proof = signedOperatorCheckpointProofSchema.shape.proof.parse({ ...file, protocol: "trackyourtime-operator-checkpoint-proof-v1", v: 1, operatorFingerprint: await fingerprint(publicKey), expiresAt: file.verifiedAt + 3_600_000 });
  const signature = await signPrivateChange(privateKey, proof); await verifyPrivateChange(publicKey, proof, signature);
  return { proof, signature };
}
/** The independent operational key must come from pinned installation policy,
 * never this request or the owner's account key. Call within the reservation
 * transaction. Revalidation does not itself reserve, activate or retire data. */
export async function verifyOperatorCheckpointProof(inputScope: OriginalStageScope, input: SignedOperatorCheckpointProof, trustedOperatorKey: PublicKey, inputConsent: SignedPrivatePreparationReservation | null = null) {
  const scope = { ...inputScope }, signed = signedOperatorCheckpointProofSchema.parse(input), key = structuredClone(trustedOperatorKey), consent = inputConsent ? signedPrivatePreparationReservationSchema.parse(inputConsent) : null, { proof } = signed;
  const current = () => {
    const now = Date.now();
    if (proof.verifiedAt > now + 30_000 || proof.expiresAt <= now || proof.expiresAt <= proof.verifiedAt || proof.expiresAt - proof.verifiedAt > 3_600_000) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Operator checkpoint proof expired. Recheck the saved file and restore drill." });
  };
  if (key.d || await fingerprint(key) !== proof.operatorFingerprint) throw new TRPCError({ code: "FORBIDDEN" });
  if (proof.server !== scope.server || proof.workspaceId !== scope.workspaceId || proof.ownerId !== scope.userId || proof.migrationId !== scope.migrationId) throw new TRPCError({ code: "NOT_FOUND" });
  current(); await verifyPrivateChange(key, proof, signed.signature);
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId); current();
    const archive = await captureOperatorCheckpointArchive(scope, proof.snapshotRoot, consent);
    if (archive.originals.modeId !== proof.modeId || archive.originals.directoryDigest !== proof.directoryDigest || archive.originals.snapshot.sourceRevision !== proof.sourceRevision || archive.originals.supplement.sourceRevision !== proof.supplementRevision || archive.controlsDigest !== proof.controlsDigest || (proof.reservationDigest ?? null) !== (archive.reservation ? hash(archive.reservation.request) : null)) throw new TRPCError({ code: "CONFLICT", message: "The saved operator checkpoint covers different originals, frozen artifacts or reservation consent. Source data was kept." });
    const mode = await PrivateWorkspace.findById(proof.modeId).lean(); if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
    requireActivePrivatePreparation(mode); current();
    beforeBusinessCommit(async () => { current(); requireActivePrivatePreparation(mode); });
    return { verified: true as const };
  });
}
