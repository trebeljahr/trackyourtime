import { z } from "zod";
import type { WorkspaceRecoveryArchive } from "@starter/shared";
import { canonicalJson, decodeSecret, deriveSecret, seal, unseal, type Ciphertext } from "./crypto.js";
import { verifyWorkspaceRecoveryArchive } from "./recovery.js";
const headerSchema = z.object({
  format: z.literal("trackyourtime-recovery-key-backup-v1"), server: z.string().max(2048),
  userId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100), createdAt: z.iso.datetime(),
}).strict();
const fileSchema = z.object({
  header: headerSchema,
  box: z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(36 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
}).strict();
export type RecoveryKeyBackup = z.infer<typeof fileSchema>;
export function parseRecoveryKeyBackup(input: unknown): RecoveryKeyBackup { const file = fileSchema.parse(input); context(file.header); return file; }
export type RecoveryBackupScope = { server: string; userId: string };
const context = (scope: RecoveryBackupScope) => {
  const origin = new URL(scope.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== scope.server || typeof scope.userId !== "string" || !scope.userId || scope.userId.length > 100) throw new Error("Invalid recovery backup scope");
  return canonicalJson({ protocol: "trackyourtime-recovery-backup-key-v1", server: scope.server, userId: scope.userId });
};
/** Derive once during explicit per-device setup. Cache only this purpose-bound
 * key inside account-encrypted storage, never the user's full recovery secret.
 * The caller must verify that the supplied recovery secret unlocks its current
 * private identity before enabling an automatic backup schedule. */
export async function deriveRecoveryBackupKey(recoveryKey: string, scope: RecoveryBackupScope): Promise<Uint8Array<ArrayBuffer>> {
  const raw = decodeSecret(recoveryKey.trim(), 32);
  try { if (raw.length !== 32) throw new Error("A 256-bit recovery key is required"); return await deriveSecret(raw, context(scope)); }
  finally { raw.fill(0); }
}
/** No account private-key envelopes or passkey IDs are needed in this file.
 * The clear header contains only routing metadata and is authenticated as AAD.
 * Recovery works offline with the saved recovery secret and this file alone. */
export async function encryptRecoveryKeyBackup(input: WorkspaceRecoveryArchive, backupKey: Uint8Array, current: () => boolean, now = new Date()): Promise<RecoveryKeyBackup> {
  const check = () => { if (!current()) throw new Error("Private data changed during backup"); };
  check(); const key = new Uint8Array(backupKey);
  try {
    if (key.length !== 32) throw new Error("A 256-bit backup key is required");
    const archive = await verifyWorkspaceRecoveryArchive(structuredClone(input)); check();
    const header = headerSchema.parse({ format: "trackyourtime-recovery-key-backup-v1", server: archive.server, userId: archive.ownerId, workspaceId: archive.snapshot.workspaceId, createdAt: now.toISOString() });
    context(header);
    const box = await seal(key, archive, canonicalJson(header)); check();
    const verified = await unseal<unknown>(key, box, canonicalJson(header)); check();
    if (canonicalJson(verified) !== canonicalJson(archive)) throw new Error("Encrypted backup failed reopening verification");
    return { header, box };
  } finally { key.fill(0); }
}
export async function decryptRecoveryKeyBackup(input: unknown, recoveryKey: string, expected?: { server: string; ownerId: string; workspaceId: string }): Promise<WorkspaceRecoveryArchive> {
  const file = fileSchema.parse(input);
  if (expected && (file.header.server !== expected.server || file.header.userId !== expected.ownerId || file.header.workspaceId !== expected.workspaceId)) throw new Error("Backup belongs to another account or workspace");
  const key = await deriveRecoveryBackupKey(recoveryKey, file.header);
  try {
    const value = await unseal<unknown>(key, file.box as Ciphertext, canonicalJson(file.header));
    return await verifyWorkspaceRecoveryArchive(value, expected ?? { server: file.header.server, ownerId: file.header.userId, workspaceId: file.header.workspaceId });
  } finally { key.fill(0); }
}
/** A folder writer reopens bytes before acknowledging a completed backup.
 * This check needs the cached purpose key, not another recovery-key prompt. */
export async function verifyRecoveryKeyBackup(input: unknown, backupKey: Uint8Array, expected: { server: string; ownerId: string; workspaceId: string }): Promise<WorkspaceRecoveryArchive> {
  const file = fileSchema.parse(input), key = new Uint8Array(backupKey);
  try {
    context(file.header);
    if (file.header.server !== expected.server || file.header.userId !== expected.ownerId || file.header.workspaceId !== expected.workspaceId) throw new Error("Backup belongs to another account or workspace");
    return await verifyWorkspaceRecoveryArchive(await unseal<unknown>(key, file.box, canonicalJson(file.header)), expected);
  } finally { key.fill(0); }
}
