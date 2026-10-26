// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { decryptPrivateWorkspaceBackup, type RecoveryBackupFolder } from "@starter/core";
import { privateRecoveryFixture } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", destinations: new Map<string, unknown>(), capture: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./private-workspace-session", () => ({ capturePrivateWorkspaceRecovery: state.capture }));
vi.mock("./recovery-backup-folder", () => ({
  recoveryBackupFolder: async (scope: unknown, value?: unknown) => { const key = JSON.stringify(scope); if (value === undefined) return state.destinations.get(key) ?? null; if (value === null) state.destinations.delete(key); else state.destinations.set(key, value); return value; },
  privateBackupFolderWriter: (folder: { port: unknown }) => folder.port,
}));
const session = await import("./private-session");
const { privateRecoveryController } = await import("./private-recovery-controller");
const closers: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); state.destinations.clear(); state.capture.mockReset(); state.origin = "https://api.example.test"; session.privateAccountChanged(null); session.lockPrivateData(); });
afterEach(() => { closers.splice(0).forEach((close) => close()); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function folder(name = "Private backups") {
  const files = new Map<string, string>(), permission = { granted: true }, requestPermission = vi.fn();
  const port: RecoveryBackupFolder = { granted: async () => permission.granted, write: async (file, contents) => { files.set(file, contents); }, read: async (file) => { const raw = files.get(file); if (raw === undefined) throw new Error("Missing file"); return raw; }, remove: async (file) => { files.delete(file); } };
  return { name, files, port, permission, requestPermission, queryPermission: async () => permission.granted ? "granted" : "denied" };
}
async function fixture() {
  const source = await privateRecoveryFixture(); session.installPrivateSession("owner", source.secrets);
  state.capture.mockImplementation(async (_user, _workspace, identity) => ({ ...structuredClone(source.archive), createdAt: new Date().toISOString(), identity }));
  const controller = await privateRecoveryController("owner", "workspace"); closers.push(controller.close);
  const directory = folder();
  const configure = (withFolder = true) => controller.configure({ recoveryKey: source.recoveryKey, identity: source.identity, intervalDays: 7, ...(withFolder ? { folder: directory as never } : {}) });
  return { ...source, controller, directory, configure };
}
it("verifies the recovery envelope once, then supports offline encrypted downloads without a writable folder", async () => {
  const f = await fixture(); expect(await f.controller.read()).toBeNull(); const settings = await f.configure(false);
  expect(settings.folderName).toBeNull(); expect(settings).not.toHaveProperty("key"); expect(settings).not.toHaveProperty("identity");
  const file = await f.controller.download(), raw = JSON.stringify(file), opened = await decryptPrivateWorkspaceBackup(file, f.recoveryKey);
  expect(opened.pending).toEqual(f.archive.replica.pending); expect(opened.records.find((row) => row.id === "tag")!.value.name).toBe("Unsent private rename");
  for (const secret of [f.secrets.master, f.recoveryKey, f.secrets.privateKey.d!]) expect(raw).not.toContain(secret);
  expect(await f.controller.run()).toEqual({ status: "off" }); expect(state.destinations.size).toBe(0);
});
it("reopens every file, schedules daily or weekly and keeps manual downloads when scheduling is disabled", async () => {
  const f = await fixture(); await f.configure(); expect((await f.controller.run()).status).toBe("saved");
  expect((await f.controller.run()).status).toBe("current"); expect(state.capture).toHaveBeenCalledTimes(1);
  const oldFiles = new Map(f.directory.files), next = folder("Another folder");
  await f.controller.configure({ recoveryKey: "", intervalDays: 1, folder: next as never });
  expect((await f.controller.run()).status).toBe("saved"); expect(next.files.size).toBe(1); expect(f.directory.files).toEqual(oldFiles);
  await f.controller.disable(); expect((await f.controller.read())!.folderName).toBeNull(); expect(next.files.size).toBe(1); expect(state.destinations.size).toBe(0);
  expect((await decryptPrivateWorkspaceBackup(await f.controller.download(), f.recoveryKey)).pending).toEqual(f.archive.replica.pending);
});
it("refuses wrong recovery keys and revoked folder access before capturing data, without prompting", async () => {
  const f = await fixture(), other = await privateRecoveryFixture();
  await expect(f.controller.configure({ recoveryKey: other.recoveryKey, identity: f.identity, intervalDays: 7 })).rejects.toThrow();
  expect(await f.controller.read()).toBeNull(); await f.configure(); f.directory.permission.granted = false;
  await expect(f.controller.run()).rejects.toThrow("Backup folder access is unavailable"); expect(state.capture).not.toHaveBeenCalled(); expect(f.directory.requestPermission).not.toHaveBeenCalled();
});
it("retains the verified recovery identity instead of accepting a replacement envelope from the server", async () => {
  const f = await fixture(), other = await privateRecoveryFixture(); await f.configure(false);
  await f.controller.configure({ recoveryKey: "", identity: other.identity, intervalDays: 1 });
  const file = await f.controller.download(); expect(state.capture.mock.calls[0]![2]).toEqual(f.identity);
  expect((await decryptPrivateWorkspaceBackup(file, f.recoveryKey)).pending).toEqual(f.archive.replica.pending);
});
it("keeps all older files and the success checkpoint after a failed readback", async () => {
  const f = await fixture(); await f.configure(); await f.controller.run(); const before = await f.controller.read(), files = new Map(f.directory.files);
  f.directory.port.read = async () => "broken";
  await expect(f.controller.run(true)).rejects.toThrow(); expect(f.directory.files).toEqual(files); expect(await f.controller.read()).toEqual(before);
});
it.each(["lock", "close"])("cancels delayed capture after %s and retains configuration and exact queued work", async (reason) => {
  const f = await fixture(); await f.configure();
  let resume!: (value: typeof f.archive) => void, enter!: () => void; const ready = new Promise<void>((resolve) => { enter = resolve; });
  state.capture.mockImplementationOnce(() => { enter(); return new Promise((resolve) => { resume = resolve; }); });
  const pending = f.controller.run(); await ready;
  if (reason === "lock") { session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); } else f.controller.close();
  resume(f.archive); await expect(pending).rejects.toThrow(/changed|closed/); expect(f.directory.files.size).toBe(0);
  const next = await privateRecoveryController("owner", "workspace"); closers.push(next.close); expect((await next.read())!.lastBackupAt).toBeNull();
  expect(await f.replica.exportRecovery()).toEqual(f.archive.replica);
});
it("serializes simultaneous jobs and invalidates handles after re-unlock", async () => {
  const f = await fixture(); await f.configure();
  expect((await Promise.all([f.controller.run(), f.controller.run()])).map((row) => row.status)).toEqual(["saved", "current"]);
  expect(f.directory.files.size).toBe(1); expect(state.capture).toHaveBeenCalledTimes(1);
  session.lockPrivateData(); session.installPrivateSession("owner", f.secrets); await expect(f.controller.download()).rejects.toThrow(/changed/);
});
