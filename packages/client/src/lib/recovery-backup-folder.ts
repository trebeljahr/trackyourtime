import { parseCombinedRecoveryKeyBackup, parsePrivateWorkspaceBackup, parseRecoveryKeyBackup, PRIVATE_RECOVERY_MAX_FILE_BYTES, type RecoveryBackupFolder } from "@starter/core";
import { privateDatabaseName } from "./private-indexed-storage";
export type BackupDirectory = FileSystemDirectoryHandle & {
  queryPermission: (options: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission: (options: { mode: "readwrite" }) => Promise<PermissionState>;
};
export type BackupFolderScope = { server: string; userId: string; workspaceId: string; destinationId: string };
const STORE = "folders";
function picker() { return (window as Window & { showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<BackupDirectory> }).showDirectoryPicker; }
export function supportsRecoveryBackupFolders(): boolean { try { return typeof window !== "undefined" && typeof picker() === "function" && !!window.indexedDB && !!navigator.locks; } catch { return false; } }
/** Must run directly from an explicit button click, before asynchronous setup
 * checks consume activation. The scheduler never calls this or requestPermission. */
export function chooseRecoveryBackupFolder(): Promise<BackupDirectory> {
  const select = picker(); if (!select) throw new Error("This app cannot choose a writable backup folder");
  return select.call(window, { id: "trackyourtime-private-backups", mode: "readwrite" });
}
async function withDatabase<T>(scope: Pick<BackupFolderScope, "server" | "userId">, action: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const name = `${await privateDatabaseName(scope)}-backup-folders`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let refused = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = (event) => {
      if (refused || event.oldVersion !== 0) { request.transaction!.abort(); return; }
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => { if (refused) { request.result.close(); return; } resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("Could not open backup folder storage"));
    request.onblocked = () => { refused = true; reject(new Error("Backup folder storage is blocked by another window")); };
  });
  db.onversionchange = () => db.close();
  try {
    if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) throw new Error("Unsupported backup folder storage; existing data was kept");
    return await action(db);
  } finally { db.close(); }
}
/** File handles need IndexedDB's structured-clone support. This separate
 * database contains capabilities/IDs only, never backup content or keys. */
export async function recoveryBackupFolder(scope: BackupFolderScope, value?: BackupDirectory | null): Promise<BackupDirectory | null> {
  if (!scope.workspaceId || scope.workspaceId.length > 100 || !/^[0-9a-f-]{36}$/.test(scope.destinationId)) throw new Error("Invalid backup workspace");
  const target = JSON.stringify([scope.workspaceId, scope.destinationId]);
  return withDatabase(scope, (db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, value === undefined ? "readonly" : "readwrite", { durability: "strict" });
    const store = tx.objectStore(STORE), request = value === undefined ? store.get(target) : value === null ? store.delete(target) : store.put(value, target);
    let found: BackupDirectory | null = null;
    request.onsuccess = () => { if (value === undefined && request.result !== undefined) found = request.result as BackupDirectory; };
    tx.oncomplete = () => resolve(value === undefined ? found : value);
    tx.onabort = () => reject(tx.error ?? new Error("Backup folder storage transaction aborted"));
  }));
}
export function backupFolderWriter(directory: BackupDirectory): RecoveryBackupFolder {
  return folderWriter(directory, false);
}
export function privateBackupFolderWriter(directory: BackupDirectory): RecoveryBackupFolder {
  return folderWriter(directory, true);
}
function folderWriter(directory: BackupDirectory, privateWorkspace: boolean): RecoveryBackupFolder {
  const limit = privateWorkspace ? PRIVATE_RECOVERY_MAX_FILE_BYTES : 36 * 1024 * 1024;
  const nameCheck = (name: string) => {
    const pattern = privateWorkspace ? /^trackyourtime-private-recovery-[0-9TZ-]+-[0-9a-f-]{36}\.tytrecovery$/ : /^trackyourtime-recovery-[0-9TZ-]+-[0-9a-f-]{36}\.tytrecovery$/;
    if (!pattern.test(name)) throw new Error("Invalid backup filename");
  };
  return {
    granted: async () => (await directory.queryPermission({ mode: "readwrite" })) === "granted",
    async write(name, contents, current) {
      nameCheck(name);
      if (contents.length > limit) throw new Error("Backup exceeds its file limit");
      const parsed = JSON.parse(contents);
      if (privateWorkspace) parsePrivateWorkspaceBackup(parsed);
      else if (parsed?.header?.format === "trackyourtime-recovery-key-backup-v2") parseCombinedRecoveryKeyBackup(parsed);
      else parseRecoveryKeyBackup(parsed);
      if (!current()) throw new Error("Private data changed during backup");
      const file = await directory.getFileHandle(name, { create: true });
      if (!current()) throw new Error("Private data changed during backup");
      const stream = await file.createWritable();
      try {
        if (!current()) throw new Error("Private data changed during backup");
        await stream.write(contents);
        if (!current()) throw new Error("Private data changed during backup");
        await stream.close();
      } catch (error) { try { await stream.abort(); } catch { /* The failed new file is removed by the job. */ } throw error; }
    },
    async read(name) { nameCheck(name); const file = await (await directory.getFileHandle(name)).getFile(); if (file.size > limit) throw new Error("Backup exceeds its file limit"); return file.text(); },
    async remove(name) { nameCheck(name); await directory.removeEntry(name); },
  };
}
export async function eraseRecoveryBackupFolders(scope: Pick<BackupFolderScope, "server" | "userId">): Promise<void> {
  const name = `${await privateDatabaseName(scope)}-backup-folders`;
  if (!navigator.locks) throw new Error("Backup folder cleanup requires Web Locks");
  await navigator.locks.request(`${await privateDatabaseName(scope)}:account`, () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not forget backup folders"));
    request.onblocked = () => reject(new Error("Another window is using backup folder storage"));
  }));
}
