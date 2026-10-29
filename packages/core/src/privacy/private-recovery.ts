import { z } from "zod";
import { privateIdentitySchema, publicEncryptionKeySchema, signedPrivateDirectorySchema } from "@starter/shared";
import { canonicalJson, decodeSecret, encodeSecret, seal, unseal, type PublicKey } from "./crypto.js";
import { privateInventoryRecoveryStateSchema, verifyPrivateInventoryRecoveryState } from "./inventory-sync.js";
import { privateReplicaRecoveryStateSchema } from "./replica.js";
import { decryptPrivateRecord, type PlainPrivateRecord } from "./records.js";
import { deriveRecoveryBackupKey } from "./recovery-backup.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { RecoveryBackupPausedError, type RecoveryBackupFolder } from "./recovery-backup-job.js";
import { privateTimerRecoveryStateSchema, verifyPrivateTimerRecoveryState, privateTimerRecoveryWorkspaceOverlay } from "./timer-recovery.js";

export const PRIVATE_RECOVERY_MAX_BYTES = 80 * 1024 * 1024;
export const PRIVATE_RECOVERY_MAX_FILE_BYTES = 160 * 1024 * 1024;
const PART_BYTES = 256 * 1024, MAX_PARTS = PRIVATE_RECOVERY_MAX_BYTES / PART_BYTES;
const scopeSchema = z.object({ server: z.string().min(1).max(2048), userId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100) }).strict();
const identitySchema = privateIdentitySchema.omit({ passkeys: true });
export type PrivateRecoveryIdentity = z.infer<typeof identitySchema>;
export const privateRecoveryBackupConfigSchema = z.object({
  v: z.literal(1), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), identity: identitySchema,
  intervalDays: z.union([z.literal(1), z.literal(7)]), destinationId: z.uuid().nullable(), folderName: z.string().max(255).nullable(),
  lastBackupAt: z.iso.datetime().nullable(), lastFileName: z.string().max(200).nullable(),
}).strict().refine((row) => (row.destinationId === null) === (row.folderName === null), "Incomplete private backup destination");
export type PrivateRecoveryBackupConfiguration = z.infer<typeof privateRecoveryBackupConfigSchema>;
const privateKeySchema = publicEncryptionKeySchema.extend({ d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const secretsSchema = z.object({ v: z.literal(1), master: z.string().regex(/^[A-Za-z0-9_-]{43}$/), privateKey: privateKeySchema, signingPrivateKey: privateKeySchema }).strict();
export type PrivateRecoverySecrets = { v: 1; master: string; privateKey: PublicKey; signingPrivateKey: PublicKey };
const legacyArchiveSchema = scopeSchema.extend({
  format: z.literal("trackyourtime-private-workspace-recovery-v1"), createdAt: z.iso.datetime(), identity: identitySchema,
  inventory: privateInventoryRecoveryStateSchema,
  directory: z.object({ signed: signedPrivateDirectorySchema, digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  replica: privateReplicaRecoveryStateSchema,
}).strict();
const archiveSchema = z.discriminatedUnion("format", [legacyArchiveSchema, legacyArchiveSchema.extend({ format: z.literal("trackyourtime-private-workspace-recovery-v2"), accountTimer: privateTimerRecoveryStateSchema }).strict()]);
export type PrivateWorkspaceRecoveryArchive = z.infer<typeof archiveSchema>;
const headerSchema = scopeSchema.extend({ format: z.literal("trackyourtime-private-workspace-backup-v1"), createdAt: z.iso.datetime(), fileId: z.uuid(), parts: z.number().int().positive().max(MAX_PARTS) }).strict();
const boxSchema = z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(512 * 1024).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const fileSchema = z.object({ header: headerSchema, manifest: boxSchema.extend({ data: boxSchema.shape.data.max(16384) }), parts: z.array(boxSchema).min(1).max(MAX_PARTS) }).strict();
export type PrivateWorkspaceBackup = z.infer<typeof fileSchema>;
const manifestSchema = z.object({ v: z.literal(1), bytes: z.number().int().positive().max(PRIVATE_RECOVERY_MAX_BYTES), parts: z.number().int().positive().max(MAX_PARTS), digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = async (bytes: Uint8Array<ArrayBuffer>) => encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const coordinates = ({ kty, crv, x, y }: z.infer<typeof publicEncryptionKeySchema>) => ({ kty, crv, x, y });
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
/** Explicit first setup: cached backup-purpose keys must never be paired with
 * a server-supplied recovery envelope that the user has not reopened. */
export async function verifyPrivateRecoveryIdentity(input: PrivateRecoveryIdentity, recoveryKey: string, inputSecrets: PrivateRecoverySecrets, scope: { server: string; userId: string }, current: () => boolean) {
  const identity = identitySchema.parse({ publicKey: input.publicKey, signingPublicKey: input.signingPublicKey, recovery: input.recovery }), secrets = secretsSchema.parse(inputSecrets), raw = decodeSecret(recoveryKey.trim(), 32);
  const check = () => { if (!current()) throw new Error("Private data changed during recovery key verification"); };
  try {
    check(); if (raw.length !== 32) throw new Error("A 256-bit recovery key is required");
    const opened = secretsSchema.parse(await unseal<unknown>(raw, identity.recovery, `trackyourtime:identity:v1:${scope.server}:${scope.userId}`)); check();
    const samePrivate = (left: PublicKey, right: PublicKey) => canonicalJson({ ...coordinates(left), d: left.d }) === canonicalJson({ ...coordinates(right), d: right.d });
    if (opened.master !== secrets.master || !samePrivate(opened.privateKey, secrets.privateKey) || !samePrivate(opened.signingPrivateKey, secrets.signingPrivateKey) || canonicalJson(coordinates(identity.publicKey)) !== canonicalJson(coordinates(secrets.privateKey)) || canonicalJson(coordinates(identity.signingPublicKey)) !== canonicalJson(coordinates(secrets.signingPrivateKey))) throw new Error("Recovery key does not match the unlocked private identity");
    return identity;
  } finally { raw.fill(0); }
}
function scopeOf(input: z.infer<typeof scopeSchema>) {
  const scope = scopeSchema.parse({ server: input.server, userId: input.userId, workspaceId: input.workspaceId }), origin = new URL(input.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== scope.server) throw new Error("Invalid private recovery origin");
  return scope;
}
/** Verify the authenticated device copy and its account policy. This is not
 * proof that no newer server/device history exists, or authority to replace it.
 * The identity recovery envelope must have been checked against the saved
 * recovery secret during backup setup; private roots never enter the archive. */
export async function verifyPrivateWorkspaceRecoveryArchive(input: unknown, inputSecrets: PrivateRecoverySecrets, current: () => boolean) {
  const check = () => { if (!current()) throw new Error("Private data changed during recovery backup"); };
  check();
  if (bytesOf(input).length > PRIVATE_RECOVERY_MAX_BYTES) throw new Error("Private recovery copy exceeds its supported size; existing data was kept");
  const archive = archiveSchema.parse(structuredClone(input)), secrets = secretsSchema.parse(inputSecrets), scope = scopeOf(archive), master = decodeSecret(secrets.master, 32);
  try {
    if (canonicalJson(coordinates(archive.identity.publicKey)) !== canonicalJson(coordinates(secrets.privateKey)) || canonicalJson(coordinates(archive.identity.signingPublicKey)) !== canonicalJson(coordinates(secrets.signingPrivateKey))) throw new Error("Private recovery identity differs from the unlocked account");
    const inventory = await verifyPrivateInventoryRecoveryState(archive.inventory, { scope, master, signingPublicKey: archive.identity.signingPublicKey, current }); check();
    const workspace = inventory.local.inventory.workspaces.find((row) => row.workspaceId === scope.workspaceId);
    if (!workspace || workspace.mode !== "encrypted") throw new Error("Private recovery needs the trusted encrypted workspace policy");
    const pin = workspace.signedPolicy.policy, directory = archive.directory.signed.directory;
    if (archive.replica.revision < 1 || !archive.replica.head || archive.replica.activationRoot !== pin.activationRoot) throw new Error("Private recovery history has no matching activation checkpoint");
    if (directory.server !== scope.server || directory.workspaceId !== scope.workspaceId || directory.revision !== pin.directoryRevision || directory.ownerId !== pin.ownerId || archive.directory.digest !== pin.directoryDigest || await privateRecordDigest(directory) !== pin.directoryDigest) throw new Error("Private recovery directory differs from the trusted policy"); check();
    const own = directory.members.find((member) => member.userId === scope.userId), owner = directory.members.find((member) => member.userId === pin.ownerId);
    if (!own || !owner || canonicalJson(coordinates(own.publicKey)) !== canonicalJson(coordinates(archive.identity.publicKey)) || canonicalJson(coordinates(own.signingPublicKey)) !== canonicalJson(coordinates(archive.identity.signingPublicKey)) || canonicalJson(coordinates(owner.signingPublicKey)) !== canonicalJson(coordinates(pin.ownerSigningPublicKey))) throw new Error("Private recovery member keys differ from its account policy");
    const seen = new Set<string>();
    for (const row of archive.replica.records) {
      if (!row.keyCommitment || row.revision > archive.replica.revision || !row.grants.some((grant) => grant.userId === scope.userId) || seen.has(address(row))) throw new Error("Private recovery contains duplicate, unrelated or unbound ciphertext");
      seen.add(address(row));
    }
    if (archive.format === "trackyourtime-private-workspace-recovery-v2") {
      await verifyPrivateTimerRecoveryState(archive.accountTimer, { scope, signingPublicKey: archive.identity.signingPublicKey, current }); check();
      const own = [];
      for (const row of archive.replica.records.filter(row => ["entries", "entryMoney"].includes(row.kind) && row.authorId === scope.userId)) { own.push(await decryptPrivateRecord(scope.workspaceId, row, scope.userId, secrets.privateKey)); check(); }
      await privateTimerRecoveryWorkspaceOverlay({ state: archive.accountTimer, replica: archive.replica, records: own, scope, privateKey: secrets.privateKey, current }); check();
    }
    check(); return archive;
  } finally { master.fill(0); }
}
export function parsePrivateWorkspaceBackup(input: unknown): PrivateWorkspaceBackup {
  if (bytesOf(input).length > PRIVATE_RECOVERY_MAX_FILE_BYTES) throw new Error("Private backup exceeds its file limit");
  const file = fileSchema.parse(input); scopeOf(file.header);
  if (file.parts.length !== file.header.parts) throw new Error("Private backup parts are incomplete");
  return file;
}
const aad = (header: PrivateWorkspaceBackup["header"], part: number | "manifest") => canonicalJson({ header, part });
async function openPayload(input: unknown, key: Uint8Array, current: () => boolean, expected?: z.infer<typeof scopeSchema>) {
  const check = () => { if (!current()) throw new Error("Private data changed during recovery backup"); };
  check(); const file = parsePrivateWorkspaceBackup(input), scope = scopeOf(file.header);
  if (expected && canonicalJson(scope) !== canonicalJson(scopeOf(expected))) throw new Error("Private backup belongs to another account or workspace");
  const manifest = manifestSchema.parse(await unseal<unknown>(key, file.manifest, aad(file.header, "manifest"))); check();
  if (manifest.parts !== file.header.parts || Math.ceil(manifest.bytes / PART_BYTES) !== manifest.parts) throw new Error("Private backup manifest differs from its parts");
  const bytes = new Uint8Array(manifest.bytes);
  try {
    let offset = 0;
    for (let index = 0; index < file.parts.length; index++) {
      const raw = await unseal<unknown>(key, file.parts[index]!, aad(file.header, index)); check();
      if (typeof raw !== "string") throw new Error("Invalid private backup part");
      const chunk = decodeSecret(raw, PART_BYTES);
      try {
        if (chunk.length !== Math.min(PART_BYTES, manifest.bytes - offset)) throw new Error("Private backup part length differs");
        bytes.set(chunk, offset); offset += chunk.length;
      } finally { chunk.fill(0); }
    }
    if (await hash(bytes) !== manifest.digest) throw new Error("Private backup data failed verification"); check();
    const archive = archiveSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (canonicalJson(scopeOf(archive)) !== canonicalJson(scope) || archive.createdAt !== file.header.createdAt) throw new Error("Private backup header differs from its data");
    return archive;
  } finally { bytes.fill(0); }
}
/** Bounded independently authenticated parts keep the full replica and exact
 * pending packets without the older single-box 32 MiB decode ceiling. Only
 * ciphertext leaves this function. Caller-owned purpose keys remain untouched. */
export async function encryptPrivateWorkspaceBackup(input: PrivateWorkspaceRecoveryArchive, backupKey: Uint8Array, secrets: PrivateRecoverySecrets, current: () => boolean) {
  const key = new Uint8Array(backupKey), snapshot = structuredClone(input), check = () => { if (!current()) throw new Error("Private data changed during recovery backup"); };
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    check(); if (key.length !== 32) throw new Error("A 256-bit private backup key is required");
    const archive = await verifyPrivateWorkspaceRecoveryArchive(snapshot, secrets, current); check(); bytes = bytesOf(archive);
    const header = headerSchema.parse({ ...scopeOf(archive), format: "trackyourtime-private-workspace-backup-v1", createdAt: archive.createdAt, fileId: crypto.randomUUID(), parts: Math.ceil(bytes.length / PART_BYTES) });
    const manifest = await seal(key, { v: 1, bytes: bytes.length, parts: header.parts, digest: await hash(bytes) }, aad(header, "manifest")); check();
    const parts = [];
    for (let index = 0; index < header.parts; index++) { parts.push(await seal(key, encodeSecret(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)), aad(header, index))); check(); }
    const file = parsePrivateWorkspaceBackup({ header, manifest, parts }), reopened = await openPayload(file, key, current, scopeOf(archive)); check();
    if (canonicalJson(reopened) !== canonicalJson(archive)) throw new Error("Private backup does not match the captured device copy");
    return file;
  } finally { key.fill(0); bytes?.fill(0); }
}
/** Readback verification uses only the cached backup-purpose key and current
 * unlocked identity. Setup separately verifies the saved recovery envelope.
 * No queued operation is replayed and no active device state is replaced. */
export async function verifyPrivateWorkspaceBackup(input: unknown, backupKey: Uint8Array, secrets: PrivateRecoverySecrets, current: () => boolean, expected: z.infer<typeof scopeSchema>) {
  const key = new Uint8Array(backupKey);
  try { return await verifyPrivateWorkspaceRecoveryArchive(await openPayload(input, key, current, expected), secrets, current); }
  finally { key.fill(0); }
}
/** Offline opening needs the saved recovery secret and file, not account login
 * or API availability. Decrypt only data for export; never return private keys
 * or install a profile from a potentially stale backup as live routing state. */
export async function decryptPrivateWorkspaceBackup(input: unknown, recoveryKey: string, expected?: z.infer<typeof scopeSchema>, current: () => boolean = () => true) {
  const check = () => { if (!current()) throw new Error("Private backup opening was canceled"); };
  check();
  const file = parsePrivateWorkspaceBackup(input), scope = scopeOf(file.header), key = await deriveRecoveryBackupKey(recoveryKey, scope);
  let raw: Uint8Array | undefined;
  try {
    const archive = await openPayload(file, key, current, expected); check();
    raw = decodeSecret(recoveryKey.trim(), 32);
    const secrets = secretsSchema.parse(await unseal<unknown>(raw, archive.identity.recovery, `trackyourtime:identity:v1:${scope.server}:${scope.userId}`));
    const checked = await verifyPrivateWorkspaceRecoveryArchive(archive, secrets, current), confirmed: PlainPrivateRecord[] = []; check();
    for (const row of checked.replica.records) { confirmed.push(await decryptPrivateRecord(scope.workspaceId, row, scope.userId, secrets.privateKey)); check(); }
    const optimistic = new Map(confirmed.map((row) => [address(row), row]));
    for (const pending of checked.replica.pending) {
      for (const row of pending.records) optimistic.set(address(row), row);
      for (const row of pending.remove) optimistic.delete(address(row));
    }
    const timerView = checked.format === "trackyourtime-private-workspace-recovery-v2" ? await privateTimerRecoveryWorkspaceOverlay({ state: checked.accountTimer, replica: checked.replica, records: confirmed, scope, privateKey: secrets.privateKey, current }) : null; check();
    return {
      format: "trackyourtime-private-workspace-export-v1" as const, ...scope, createdAt: checked.createdAt,
      checkpoint: { activationRoot: checked.replica.activationRoot!, revision: checked.replica.revision, head: checked.replica.head! },
      accountInventory: { localRevision: checked.inventory.local.inventory.revision, confirmedRevision: checked.inventory.confirmed.checkpoint.revision, pending: checked.inventory.pending.length, conflict: checked.inventory.conflict !== null },
      confirmedRecords: confirmed, records: timerView?.records ?? [...optimistic.values()], pending: checked.replica.pending,
      ...(checked.format === "trackyourtime-private-workspace-recovery-v2" ? { accountTimer: checked.accountTimer } : {}),
      ...(timerView?.conflict ? { recoveryConflict: true as const } : {}),
    };
  } finally { key.fill(0); raw?.fill(0); }
}

/** The job lock must differ from the replica lock used by snapshot(). Only a
 * newly named file is touched; success requires reopening the actual file and
 * comparing the entire captured state, including exact pending packets. */
export async function writePrivateWorkspaceBackup(options: {
  scope: z.infer<typeof scopeSchema>; key: Uint8Array; secrets: () => PrivateRecoverySecrets;
  current: () => boolean; folder: RecoveryBackupFolder; snapshot: () => Promise<PrivateWorkspaceRecoveryArchive>;
}) {
  const key = new Uint8Array(options.key), scope = { ...options.scope }, { current, folder } = options;
  const check = () => { if (!current()) throw new Error("Private data changed during backup"); };
  let created: string | null = null;
  try {
    check(); if (!await folder.granted()) throw new RecoveryBackupPausedError(); check();
    const archive = await options.snapshot(); check();
    if (canonicalJson(scopeOf(archive)) !== canonicalJson(scopeOf(scope))) throw new Error("Private backup belongs to another account or workspace");
    const encrypted = await encryptPrivateWorkspaceBackup(archive, key, options.secrets(), current); check();
    const name = `trackyourtime-private-recovery-${archive.createdAt.replace(/[:.]/g, "-")}-${encrypted.header.fileId}.tytrecovery`;
    if (!await folder.granted()) throw new RecoveryBackupPausedError(); check();
    created = name; await folder.write(name, JSON.stringify(encrypted), current); check();
    const raw = await folder.read(name); check();
    if (raw.length > PRIVATE_RECOVERY_MAX_FILE_BYTES) throw new Error("Written private backup exceeds its file limit");
    const reopened = await verifyPrivateWorkspaceBackup(JSON.parse(raw), key, options.secrets(), current, scope); check();
    if (canonicalJson(reopened) !== canonicalJson(archive)) throw new Error("Written private backup does not match the captured device copy");
    return { fileName: name, createdAt: archive.createdAt };
  } catch (error) {
    if (created) { try { await folder.remove(created); } catch { /* Existing backups remain untouched. */ } }
    throw error;
  } finally { key.fill(0); }
}
