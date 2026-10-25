// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { decryptRecoveryKeyBackup, decryptCombinedRecoveryKeyBackup, emptyRecoverySupplementCollections, recoverySupplementDigest, emptyRecoveryCollections, recoveryDigest, type RecoveryBackupFolder } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", destinations: new Map<string, unknown>() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./recovery-backup-folder", () => ({
  recoveryBackupFolder: async (scope: unknown, value?: unknown) => { const key = JSON.stringify(scope); if (value === undefined) return state.destinations.get(key) ?? null; if (value === null) state.destinations.delete(key); else state.destinations.set(key, value); return value; },
  backupFolderWriter: (folder: { port: unknown }) => folder.port,
}));
const session = await import("./private-session");
const { recoveryBackupController } = await import("./recovery-backup-controller");
const closers: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); state.destinations.clear(); session.privateAccountChanged(null); session.lockPrivateData(); });
afterEach(() => { closers.splice(0).forEach((close) => close()); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function folder(name = "Private backups") {
  const files = new Map<string, string>(), permission = { granted: true }, requestPermission = vi.fn();
  const port: RecoveryBackupFolder = { granted: async () => permission.granted, write: async (file, contents) => { files.set(file, contents); }, read: async (file) => { const raw = files.get(file); if (raw === undefined) throw new Error("Missing file"); return raw; }, remove: async (file) => { files.delete(file); } };
  return { name, files, port, permission, requestPermission, queryPermission: async () => permission.granted ? "granted" : "denied" };
}
async function fixture() {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  const controller = await recoveryBackupController("owner", "workspace"); closers.push(controller.close);
  const directory = folder(), collections = emptyRecoveryCollections(); collections.invoices.push({ _id: { $oid: "0123456789abcdef01234567" }, workspaceId: "workspace", xml: "<Invoice>Private original XML</Invoice>", amount: { $numberDecimal: "12.3400" } });
  const archive = { format: "trackyourtime-workspace-recovery-v1" as const, server: state.origin, ownerId: "owner", snapshot: { v: 1 as const, workspaceId: "workspace", createdAt: "2026-10-24T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections } };
  const configure = (next = directory) => controller.configure({ recoveryKey: root.recoveryKey, identity: root.identity, folder: next as never, intervalDays: 7 });
  return { root, controller, directory, archive, configure };
}
it("enables an explicit schedule, persists encrypted settings, verifies files and skips backups already current", async () => {
  const f = await fixture(); expect(await f.controller.read()).toBeNull();
  const settings = await f.configure(); expect(settings).not.toHaveProperty("key"); expect(settings).not.toHaveProperty("destinationId");
  const snapshot = vi.fn(async () => f.archive);
  expect((await f.controller.run(snapshot)).status).toBe("saved"); expect(f.directory.files.size).toBe(1);
  const raw = [...f.directory.files.values()][0]!;
  expect(raw).not.toContain("Private original XML"); expect(raw).not.toContain(f.root.recoveryKey);
  expect(await decryptRecoveryKeyBackup(JSON.parse(raw), f.root.recoveryKey)).toEqual(f.archive);
  expect((await f.controller.run(snapshot)).status).toBe("current"); expect(snapshot).toHaveBeenCalledTimes(1);
  expect((await f.controller.run(snapshot, true)).status).toBe("saved"); expect(f.directory.files.size).toBe(2);
  await f.controller.disable(); expect(await f.controller.read()).toBeNull(); expect(f.directory.files.size).toBe(2); expect(state.destinations.size).toBe(0);
});
it("refuses an incorrect recovery key and revoked permission without prompting or reading server records", async () => {
  const f = await fixture(), other = await session.newPrivateIdentity("other");
  await expect(f.controller.configure({ recoveryKey: other.recoveryKey, identity: f.root.identity, folder: f.directory as never, intervalDays: 7 })).rejects.toThrow();
  expect(state.destinations.size).toBe(0); await f.configure();
  f.directory.permission.granted = false; const snapshot = vi.fn(async () => f.archive);
  await expect(f.controller.run(snapshot)).rejects.toThrow("Backup folder access is unavailable");
  expect(snapshot).not.toHaveBeenCalled(); expect(f.directory.requestPermission).not.toHaveBeenCalled(); expect(f.directory.files.size).toBe(0);
});
it("keeps older files and the success checkpoint when the new file cannot be verified", async () => {
  const f = await fixture(); await f.configure(); await f.controller.run(async () => f.archive);
  const before = await f.controller.read(), old = new Map(f.directory.files);
  f.directory.port.read = async () => "corrupted file";
  await expect(f.controller.run(async () => f.archive, true)).rejects.toThrow();
  expect(f.directory.files).toEqual(old); expect(await f.controller.read()).toEqual(before);
});
it("cancels a locked in-flight snapshot and resumes its saved schedule after a fresh unlock", async () => {
  const f = await fixture(); await f.configure();
  let release!: (value: typeof f.archive) => void, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const pending = f.controller.run(() => { started(); return new Promise((resolve) => { release = resolve; }); });
  await ready; session.lockPrivateData(); release(f.archive);
  await expect(pending).rejects.toThrow("Private data changed"); expect(f.directory.files.size).toBe(0);
  session.installPrivateSession("owner", f.root.secrets);
  const next = await recoveryBackupController("owner", "workspace"); closers.push(next.close);
  expect((await next.read())!.intervalDays).toBe(7); expect((await next.run(async () => f.archive)).status).toBe("saved");
});
it("keeps staged folder handles after an uncertain config commit so a new unlock can finish", async () => {
  const f = await fixture(); await f.configure(); const nextFolder = folder("New backup folder"), put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    const request = Reflect.apply(put, this, args) as IDBRequest<IDBValidKey>;
    if (String(args[1]).endsWith("automatic-recovery-backup")) request.addEventListener("success", () => session.lockPrivateData());
    return request;
  });
  await expect(f.configure(nextFolder)).rejects.toThrow(); vi.restoreAllMocks();
  session.installPrivateSession("owner", f.root.secrets);
  const next = await recoveryBackupController("owner", "workspace"); closers.push(next.close);
  expect((await next.read())!.folderName).toBe("New backup folder");
  expect((await next.run(async () => f.archive)).status).toBe("saved"); expect(nextFolder.files.size).toBe(1);
});


it("changes an existing schedule and destination using its encrypted key cache without another recovery prompt", async () => {
  const f = await fixture(); await f.configure();
  const next = folder("Changed folder");
  const settings = await f.controller.configure({ recoveryKey: "", folder: next as never, intervalDays: 1 });
  expect(settings.intervalDays).toBe(1); expect(settings.folderName).toBe("Changed folder");
  expect((await f.controller.run(async () => f.archive)).status).toBe("saved");
  expect(await decryptRecoveryKeyBackup(JSON.parse([...next.files.values()][0]!), f.root.recoveryKey)).toEqual(f.archive);
});

it("writes combined scheduled snapshots with supplemental originals and reopens them before advancing success", async () => {
  const f = await fixture(); await f.configure();
  const collections = emptyRecoverySupplementCollections();
  collections.organization.push({ _id: "workspace", name: "Original workspace" });
  collections.webhooksubscriptions.push({ _id: "hook", workspaceId: "workspace", createdBy: "owner", secret: "Private original webhook secret" });
  const archive = { ...f.archive, format: "trackyourtime-workspace-recovery-v2" as const, supplement: { v: 1 as const, workspaceId: "workspace", createdAt: f.archive.snapshot.createdAt, collections, sourceRevision: await recoverySupplementDigest(collections) } };
  expect((await f.controller.run(async () => archive)).status).toBe("saved");
  const raw = [...f.directory.files.values()][0]!;
  expect(JSON.parse(raw).header.format).toBe("trackyourtime-recovery-key-backup-v2");
  expect(raw).not.toContain("Private original webhook secret");
  expect(await decryptCombinedRecoveryKeyBackup(JSON.parse(raw), f.root.recoveryKey)).toEqual(archive);
  const saved = await f.controller.read(), previous = new Map(f.directory.files);
  f.directory.port.read = async () => "invalid combined file";
  await expect(f.controller.run(async () => archive, true)).rejects.toThrow();
  expect(await f.controller.read()).toEqual(saved); expect(f.directory.files).toEqual(previous);
});
