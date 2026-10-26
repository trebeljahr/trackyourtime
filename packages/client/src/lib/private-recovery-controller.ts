import { decodeSecret, deriveRecoveryBackupKey, encodeSecret, encryptPrivateWorkspaceBackup, privateRecoveryBackupConfigSchema, verifyPrivateRecoveryIdentity, writePrivateWorkspaceBackup, type PrivateRecoveryBackupConfiguration, type PrivateRecoveryIdentity } from "@starter/core";
import { privateClientScope } from "./private-client-scope";
import { privateSession, privateWorkspaceStorage } from "./private-session";
import { privateWorkspaceStorageHost } from "./private-replica";
import { privateDatabaseName } from "./private-indexed-storage";
import { capturePrivateWorkspaceRecovery } from "./private-workspace-session";
import { privateBackupFolderWriter, recoveryBackupFolder, type BackupDirectory } from "./recovery-backup-folder";
const CONFIG = "private-workspace-recovery-backup";
const configSchema = privateRecoveryBackupConfigSchema;
type Config = PrivateRecoveryBackupConfiguration;
export type PrivateRecoverySettings = Pick<Config, "intervalDays" | "folderName" | "lastBackupAt" | "lastFileName">;
const publicSettings = ({ intervalDays, folderName, lastBackupAt, lastFileName }: Config): PrivateRecoverySettings => ({ intervalDays, folderName, lastBackupAt, lastFileName });
/** Separate from plaintext owner backups. Retain only public scope/epoch;
 * resolve keys during each operation. The job lock has no account/workspace
 * lock parent: capture opens its own hosts, so queued account deletion cannot
 * deadlock a nested shared lock. Closed hosts refuse late config writes. */
export async function privateRecoveryController(userId: string, workspaceId: string) {
  const binding = privateClientScope(userId), scope = { server: binding.server, userId, workspaceId };
  let closed = false;
  const current = () => !closed && binding.current();
  const check = () => { binding.check(); if (closed) throw new Error("Private backup controller was closed"); };
  const host = await privateWorkspaceStorageHost(userId, workspaceId);
  try {
    const storage = await privateWorkspaceStorage(userId, workspaceId, host.storage), name = await privateDatabaseName(scope); check();
    if (!navigator.locks) throw new Error("Private backups require Web Locks");
    const suffix = encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workspaceId)))); check();
    const exclusive = <T>(task: () => Promise<T>) => navigator.locks.request(`${name}:private-backup:${suffix}`, async () => { check(); return task(); });
    const load = async (): Promise<Config | null> => { const raw = await storage.getItem(CONFIG); check(); return raw === null ? null : configSchema.parse(JSON.parse(raw)); };
    const save = async (value: Config) => { check(); await storage.setItem(CONFIG, JSON.stringify(value)); check(); };
    const snapshot = async (identity: PrivateRecoveryIdentity) => { check(); const archive = await capturePrivateWorkspaceRecovery(userId, workspaceId, identity); check(); return archive; };
    return {
      close: () => { closed = true; host.close(); },
      read: () => exclusive(async () => { const value = await load(); return value ? publicSettings(value) : null; }),
      configure: (input: { recoveryKey: string; identity?: PrivateRecoveryIdentity; folder?: BackupDirectory; intervalDays: 1 | 7 }) => {
        const recoveryKey = input.recoveryKey, identity = input.identity ? structuredClone(input.identity) : undefined, folder = input.folder, intervalDays = input.intervalDays;
        return exclusive(async () => {
          const previous = await load(); let key: Uint8Array | undefined, destinationId: string | null = null, commitAttempted = false;
          try {
            let verified: PrivateRecoveryIdentity;
            if (previous && !recoveryKey.trim()) { key = decodeSecret(previous.key, 32); verified = previous.identity; }
            else {
              if (!identity) throw new Error("Verify your saved recovery key first");
              verified = await verifyPrivateRecoveryIdentity(identity, recoveryKey, privateSession(userId)!, scope, current); check();
              key = await deriveRecoveryBackupKey(recoveryKey, scope); check();
            }
            if (folder) {
              if (await folder.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error("Backup folder access was not granted"); check();
              destinationId = crypto.randomUUID(); await recoveryBackupFolder({ ...scope, destinationId }, folder); check();
            }
            const value = configSchema.parse({ v: 1, key: encodeSecret(key), identity: verified, intervalDays,
              destinationId: destinationId ?? previous?.destinationId ?? null, folderName: folder?.name ?? previous?.folderName ?? null,
              lastBackupAt: folder ? null : previous?.lastBackupAt ?? null, lastFileName: folder ? null : previous?.lastFileName ?? null });
            commitAttempted = true; await save(value); destinationId = null;
            if (folder && previous?.destinationId) { try { await recoveryBackupFolder({ ...scope, destinationId: previous.destinationId }, null); } catch { /* Obsolete handle only. */ } }
            return publicSettings(value);
          } finally {
            key?.fill(0);
            if (destinationId && !commitAttempted) { try { await recoveryBackupFolder({ ...scope, destinationId }, null); } catch { /* Account deletion also removes handles. */ } }
          }
        });
      },
      download: () => exclusive(async () => {
        const config = await load(); if (!config) throw new Error("Verify your saved recovery key first");
        const key = decodeSecret(config.key, 32);
        try { const archive = await snapshot(config.identity); check(); const file = await encryptPrivateWorkspaceBackup(archive, key, privateSession(userId)!, current); check(); return file; }
        finally { key.fill(0); }
      }),
      disable: () => exclusive(async () => {
        const config = await load(); if (!config) return;
        await save({ ...config, destinationId: null, folderName: null });
        if (config.destinationId) await recoveryBackupFolder({ ...scope, destinationId: config.destinationId }, null);
      }),
      run: (force = false) => exclusive(async () => {
        const config = await load(); if (!config?.destinationId) return { status: "off" as const };
        const elapsed = config.lastBackupAt ? Date.now() - Date.parse(config.lastBackupAt) : null;
        if (!force && elapsed !== null && elapsed >= 0 && elapsed < config.intervalDays * 86400000) return { status: "current" as const, settings: publicSettings(config) };
        const directory = await recoveryBackupFolder({ ...scope, destinationId: config.destinationId }); check();
        if (!directory) return { status: "folder-unavailable" as const };
        const key = decodeSecret(config.key, 32);
        try {
          const result = await writePrivateWorkspaceBackup({ scope, key, current, secrets: () => { check(); return privateSession(userId)!; }, folder: privateBackupFolderWriter(directory), snapshot: () => snapshot(config.identity) }); check();
          const next = { ...config, lastBackupAt: result.createdAt, lastFileName: result.fileName }; await save(next);
          return { status: "saved" as const, settings: publicSettings(next) };
        } finally { key.fill(0); }
      }),
    };
  } catch (error) { closed = true; host.close(); throw error; }
}
