import { z } from "zod";
import type { CombinedWorkspaceRecoveryArchive } from "@starter/shared";
import { canonicalJson, seal, unseal } from "./crypto.js";
import { deriveRecoveryBackupKey } from "./recovery-backup.js";
import { verifyCombinedWorkspaceRecoveryArchive } from "./combined-recovery.js";
const headerSchema = z.object({
  format: z.literal("trackyourtime-recovery-key-backup-v2"), server: z.string().max(2048),
  userId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100), createdAt: z.iso.datetime(),
}).strict();
const fileSchema = z.object({ header: headerSchema, box: z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(36 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/) }).strict() }).strict();
export type CombinedRecoveryKeyBackup = z.infer<typeof fileSchema>;
type Scope = { server: string; ownerId: string; workspaceId: string };
export function parseCombinedRecoveryKeyBackup(value: unknown): CombinedRecoveryKeyBackup {
  const file = fileSchema.parse(value), origin = new URL(file.header.server);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== file.header.server) throw new Error("Invalid combined backup origin");
  return file;
}
function scopeOf(file: CombinedRecoveryKeyBackup, expected?: Scope): Scope {
  const scope = { server: file.header.server, ownerId: file.header.userId, workspaceId: file.header.workspaceId };
  if (expected && (scope.server !== expected.server || scope.ownerId !== expected.ownerId || scope.workspaceId !== expected.workspaceId)) throw new Error("Backup belongs to another account or workspace");
  return scope;
}
/** The distinct authenticated v2 header prevents a combined file from silently
 * being treated as the old fourteen-collection backup. Only ciphertext and
 * routing metadata leave this function; caller-owned keys are not cleared. */
export async function encryptCombinedRecoveryKeyBackup(input: CombinedWorkspaceRecoveryArchive, backupKey: Uint8Array, current: () => boolean, now = new Date()): Promise<CombinedRecoveryKeyBackup> {
  const key = new Uint8Array(backupKey), check = () => { if (!current()) throw new Error("Private data changed during combined backup"); };
  try {
    check(); if (key.length !== 32) throw new Error("A 256-bit backup key is required");
    const archive = await verifyCombinedWorkspaceRecoveryArchive(input); check();
    const header = headerSchema.parse({ format: "trackyourtime-recovery-key-backup-v2", server: archive.server, userId: archive.ownerId, workspaceId: archive.snapshot.workspaceId, createdAt: now.toISOString() });
    const box = await seal(key, archive, canonicalJson(header)); check();
    const reopened = await unseal<unknown>(key, box, canonicalJson(header)); check();
    if (canonicalJson(reopened) !== canonicalJson(archive)) throw new Error("Combined backup failed reopening verification");
    return parseCombinedRecoveryKeyBackup({ header, box });
  } finally { key.fill(0); }
}
export async function verifyCombinedRecoveryKeyBackup(input: unknown, backupKey: Uint8Array, expected: Scope): Promise<CombinedWorkspaceRecoveryArchive> {
  const file = parseCombinedRecoveryKeyBackup(input), key = new Uint8Array(backupKey);
  try {
    const scope = scopeOf(file, expected);
    return await verifyCombinedWorkspaceRecoveryArchive(await unseal<unknown>(key, file.box, canonicalJson(file.header)), scope);
  } finally { key.fill(0); }
}
export async function decryptCombinedRecoveryKeyBackup(input: unknown, recoveryKey: string, expected?: Scope): Promise<CombinedWorkspaceRecoveryArchive> {
  const file = parseCombinedRecoveryKeyBackup(input), scope = scopeOf(file, expected);
  const key = await deriveRecoveryBackupKey(recoveryKey, { server: scope.server, userId: scope.ownerId });
  try { return await verifyCombinedRecoveryKeyBackup(file, key, scope); } finally { key.fill(0); }
}
