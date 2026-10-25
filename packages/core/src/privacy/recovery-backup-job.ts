import { z } from "zod";
import type { CombinedWorkspaceRecoveryArchive, WorkspaceRecoveryArchive } from "@starter/shared";
import { canonicalJson } from "./crypto.js";
import { encryptCombinedRecoveryKeyBackup, verifyCombinedRecoveryKeyBackup } from "./combined-recovery-backup.js";
import { verifyCombinedWorkspaceRecoveryArchive } from "./combined-recovery.js";
import { encryptRecoveryKeyBackup, verifyRecoveryKeyBackup } from "./recovery-backup.js";
import { verifyWorkspaceRecoveryArchive } from "./recovery.js";
export type RecoveryBackupFolder = {
  /** Query only. Automatic jobs must never request permission or open a picker. */
  granted: () => Promise<boolean>;
  write: (name: string, contents: string, current: () => boolean) => Promise<void>;
  read: (name: string) => Promise<string>;
  remove: (name: string) => Promise<void>;
};
export class RecoveryBackupPausedError extends Error {
  constructor() { super("Backup folder access is unavailable; choose or authorize the folder in Settings"); this.name = "RecoveryBackupPausedError"; }
}
/** Caller holds its inter-window workspace lock. Only ciphertext reaches the
 * folder. Keep previous files untouched; acknowledge only after reopening the
 * newly written file and verifying the complete original typed snapshot. */
export async function writeRecoveryBackup(options: {
  scope: { server: string; ownerId: string; workspaceId: string }; key: Uint8Array;
  current: () => boolean; folder: RecoveryBackupFolder; snapshot: () => Promise<WorkspaceRecoveryArchive | CombinedWorkspaceRecoveryArchive>; now?: Date;
}) {
  const { folder, current } = options, scope = { ...options.scope }, key = new Uint8Array(options.key), stamp = (options.now ?? new Date()).toISOString();
  const check = () => { if (!current()) throw new Error("Private data changed during backup"); };
  let created: string | null = null;
  try {
    check(); if (!await folder.granted()) throw new RecoveryBackupPausedError(); check();
    const source = await options.snapshot(); check();
    const archive = source.format === "trackyourtime-workspace-recovery-v2"
      ? await verifyCombinedWorkspaceRecoveryArchive(structuredClone(source), scope)
      : await verifyWorkspaceRecoveryArchive(structuredClone(source), scope); check();
    const encrypted = archive.format === "trackyourtime-workspace-recovery-v2"
      ? await encryptCombinedRecoveryKeyBackup(archive, key, current, new Date(stamp))
      : await encryptRecoveryKeyBackup(archive, key, current, new Date(stamp)); check();
    // No names, projects, customer details or filesystem paths in filenames.
    const name = `trackyourtime-recovery-${stamp.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.tytrecovery`;
    if (!await folder.granted()) throw new RecoveryBackupPausedError(); check();
    created = name; await folder.write(name, JSON.stringify(encrypted), current); check();
    const raw = await folder.read(name); check();
    if (raw.length > 36 * 1024 * 1024) throw new Error("Written backup exceeds its file limit");
    const reopened = archive.format === "trackyourtime-workspace-recovery-v2"
      ? await verifyCombinedRecoveryKeyBackup(JSON.parse(raw), key, scope)
      : await verifyRecoveryKeyBackup(JSON.parse(raw), key, scope); check();
    if (canonicalJson(reopened) !== canonicalJson(archive)) throw new Error("Written backup does not match the source snapshot");
    return { fileName: name, createdAt: stamp, sourceRevision: archive.snapshot.sourceRevision, ...(archive.format === "trackyourtime-workspace-recovery-v2" ? { supplementRevision: archive.supplement.sourceRevision } : {}) };
  } catch (error) {
    if (created) { try { await folder.remove(created); } catch { /* Only this failed new file may remain; previous backups were kept. */ } }
    throw error;
  } finally { key.fill(0); }
}


export const recoveryBackupConfigSchema = z.object({
  v: z.literal(1), intervalDays: z.union([z.literal(1), z.literal(7)]), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  destinationId: z.uuid(), folderName: z.string().max(255), lastBackupAt: z.iso.datetime().nullable(), lastFileName: z.string().max(200).nullable(),
}).strict();
export type RecoveryBackupConfiguration = z.infer<typeof recoveryBackupConfigSchema>;
