import { recoveryBackupConfigSchema, type RecoveryBackupConfiguration, canonicalJson, decodeSecret, deriveRecoveryBackupKey, encodeSecret, unseal, writeRecoveryBackup, type WorkspaceRecoveryArchive } from "@starter/core";
import type { PrivateIdentity } from "@starter/shared";
import { privateDataOrigin, privateOperationScope, privateSession, privateWorkspaceStorage, type UnlockedIdentity } from "./private-session";
import { privateWorkspaceStorageHost } from "./private-replica";
import { backupFolderWriter, recoveryBackupFolder, type BackupDirectory } from "./recovery-backup-folder";
const CONFIG = "automatic-recovery-backup";
const configSchema = recoveryBackupConfigSchema;
type Config = RecoveryBackupConfiguration;
export type RecoveryBackupSettings = Omit<Config, "key" | "destinationId" | "v">;
const publicSettings = ({ intervalDays, folderName, lastBackupAt, lastFileName }: Config): RecoveryBackupSettings => ({ intervalDays, folderName, lastBackupAt, lastFileName });
/** Configuration and purpose keys remain encrypted. Folder handles stage under
 * a fresh ID before the config pointer commits, preserving the previous setup
 * if persistence fails. Every operation uses the host's account/workspace lock. */
export async function recoveryBackupController(userId: string, workspaceId: string) {
  const root = privateSession(userId); if (!root) throw new Error("Unlock private data first");
  const check = privateOperationScope(userId), server = privateDataOrigin(), scope = { server, userId, workspaceId };
  const current = () => { try { check(); return privateSession(userId) === root; } catch { return false; } };
  const assertCurrent = () => { if (!current()) throw new Error("Private data changed during backup"); };
  const host = await privateWorkspaceStorageHost(userId, workspaceId);
  try {
    const storage = await privateWorkspaceStorage(userId, workspaceId, host.storage); assertCurrent();
    const load = async (): Promise<Config | null> => { const raw = await storage.getItem(CONFIG); assertCurrent(); return raw === null ? null : configSchema.parse(JSON.parse(raw)); };
    return {
      close: host.close,
      read: () => host.exclusive(async () => { assertCurrent(); const config = await load(); return config ? publicSettings(config) : null; }),
      configure: (options: { recoveryKey: string; identity?: PrivateIdentity; folder: BackupDirectory; intervalDays: 1 | 7 }) => {
        // Snapshot strings/envelopes before waiting for another window's lock.
        const identity = options.identity ? structuredClone(options.identity) : undefined, recoveryKey = options.recoveryKey, folder = options.folder, intervalDays = options.intervalDays;
        return host.exclusive(async () => {
          assertCurrent(); const previous = await load();
          let raw: Uint8Array | undefined;
          let key: Uint8Array | undefined, destinationId: string | null = null, commitAttempted = false;
          try {
            if (previous && !recoveryKey.trim()) {
              key = decodeSecret(previous.key, 32);
            } else {
              if (!identity) throw new Error("Verify the recovery key before enabling backups");
              raw = decodeSecret(recoveryKey.trim(), 32);
              if (raw.length !== 32) throw new Error("Invalid recovery key");
              const opened = await unseal<UnlockedIdentity>(raw, identity.recovery, `trackyourtime:identity:v1:${server}:${userId}`); assertCurrent();
              const coordinates = ({ kty, crv, x, y, d }: UnlockedIdentity["privateKey"]) => ({ kty, crv, x, y, d });
              if (opened.v !== 1 || opened.master !== root.master || canonicalJson(coordinates(opened.privateKey)) !== canonicalJson(coordinates(root.privateKey)) || canonicalJson(coordinates(opened.signingPrivateKey)) !== canonicalJson(coordinates(root.signingPrivateKey))) throw new Error("Recovery key does not match the unlocked account");
              key = await deriveRecoveryBackupKey(recoveryKey, scope); assertCurrent();
            }
            if (await folder.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error("Backup folder access was not granted"); assertCurrent();
            destinationId = crypto.randomUUID();
            await recoveryBackupFolder({ ...scope, destinationId }, folder); assertCurrent();
            const config: Config = configSchema.parse({ v: 1, intervalDays, key: encodeSecret(key), destinationId, folderName: folder.name, lastBackupAt: null, lastFileName: null });
            commitAttempted = true;
            await storage.setItem(CONFIG, JSON.stringify(config)); assertCurrent();
            destinationId = null; // Committed. Do not remove a live destination.
            if (previous) { try { await recoveryBackupFolder({ ...scope, destinationId: previous.destinationId }, null); } catch { /* Old capability only; no key/content is stored there. */ } }
            return publicSettings(config);
          } finally {
            raw?.fill(0); key?.fill(0);
            // A cancelled acknowledgement can follow a committed pointer.
            // Keep both handles after an uncertain save so either pointer works.
            if (destinationId && !commitAttempted) { try { await recoveryBackupFolder({ ...scope, destinationId }, null); } catch { /* Account deletion also clears this scoped database. */ } }
          }
        });
      },
      disable: () => host.exclusive(async () => {
        assertCurrent(); const config = await load(); await storage.removeItem(CONFIG); assertCurrent();
        if (config) await recoveryBackupFolder({ ...scope, destinationId: config.destinationId }, null);
      }),
      run: (snapshot: () => Promise<WorkspaceRecoveryArchive>, force = false) => host.exclusive(async () => {
        assertCurrent(); const config = await load();
        if (!config) return { status: "off" as const };
        const elapsed = config.lastBackupAt ? Date.now() - Date.parse(config.lastBackupAt) : null;
        if (!force && elapsed !== null && elapsed >= 0 && elapsed < config.intervalDays * 86400000) return { status: "current" as const, settings: publicSettings(config) };
        const directory = await recoveryBackupFolder({ ...scope, destinationId: config.destinationId }); assertCurrent();
        if (!directory) return { status: "folder-unavailable" as const };
        const key = decodeSecret(config.key, 32);
        try {
          const result = await writeRecoveryBackup({ key, scope: { server, ownerId: userId, workspaceId }, current, folder: backupFolderWriter(directory), snapshot }); assertCurrent();
          const next = { ...config, lastBackupAt: result.createdAt, lastFileName: result.fileName };
          await storage.setItem(CONFIG, JSON.stringify(next)); assertCurrent();
          return { status: "saved" as const, settings: publicSettings(next) };
        } finally { key.fill(0); }
      }),
    };
  } catch (error) { host.close(); throw error; }
}
