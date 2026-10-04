// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOfflineQueueForTests, __resetOfflineQueueOwnerForTests, adoptUnstampedOfflineRows, enqueueOffline, getOfflineQueue, OfflineQueueScopeNotReadyError, setOfflineQueueOwner } from "./offline";
import { __resetActiveWorkspaceForTests } from "./active-workspace";
import { OFFLINE_QUEUE_STORAGE_KEY, type OfflineCreateInput } from "@starter/core";

const input: OfflineCreateInput = {
  description: "My draft", projectId: null, taskId: null, billable: false,
  start: "2026-10-01T09:00:00.000Z", end: "2026-10-01T10:00:00.000Z",
  source: "web", timeZone: "UTC", originId: "test",
};

beforeEach(async () => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  __resetOfflineQueueForTests();
  __resetOfflineQueueOwnerForTests();
  __resetActiveWorkspaceForTests();
  await setOfflineQueueOwner("user-a");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("browser offline save durability", () => {
  for (const unknown of ["account", "workspace"] as const) {
    it(`refuses an explicitly unresolved ${unknown} instead of minting an adoptable row`, async () => {
      await setOfflineQueueOwner("user-b");
      await expect(enqueueOffline("entries.create", input, "temp-cold-draft",
        unknown === "workspace" ? null : "ws-a",
        { owner: unknown === "account" ? null : "user-a", server: "http://localhost:3000" },
      )).rejects.toBeInstanceOf(OfflineQueueScopeNotReadyError);
      expect(await getOfflineQueue().list()).toEqual([]);
      await setOfflineQueueOwner("user-c");
      expect(await adoptUnstampedOfflineRows("ws-c")).toBe(0);
      expect(await getOfflineQueue().list()).toEqual([]);
    });
  }

  it("leaves a cold unresolved draft unqueued when another account resolves later", async () => {
    __resetOfflineQueueOwnerForTests();
    window.localStorage.clear();
    await expect(enqueueOffline("entries.create", input, "temp-cold-draft", null,
      { owner: null, server: "http://localhost:3000" },
    )).rejects.toThrow("account or workspace is still loading");
    await setOfflineQueueOwner("user-b");
    expect(await adoptUnstampedOfflineRows("ws-b")).toBe(0);
    expect(await getOfflineQueue().list()).toEqual([]);
  });
  it("rejects a quota failure, leaves no queued success, then allows retry", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("Disk full", "QuotaExceededError"); });
    await expect(enqueueOffline("entries.create", input, "temp-draft", "ws-a")).rejects.toThrow("Disk full");
    expect(await getOfflineQueue().list()).toEqual([]);
    write.mockRestore();
    await enqueueOffline("entries.create", input, "temp-draft", "ws-a");
    expect(await getOfflineQueue().list()).toHaveLength(1);
  });

  it("never overwrites an existing queue when reading storage fails", async () => {
    await enqueueOffline("entries.create", input, "temp-first", "ws-a");
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => { throw new Error("Storage denied"); });
    await expect(enqueueOffline("entries.create", input, "temp-second", "ws-a")).rejects.toThrow("Storage denied");
    read.mockRestore();
    expect((await getOfflineQueue().list()).map((row) => row.payload)).toEqual([{ input: { ...input, operationId: expect.any(String) }, tempId: "temp-first" }]);
  });

  it("acknowledges persistence even when the pending-count refresh fails", async () => {
    const original = Storage.prototype.getItem;
    let reads = 0;
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === OFFLINE_QUEUE_STORAGE_KEY && ++reads === 2) throw new Error("Count unavailable");
      return original.call(this, key);
    });
    await expect(enqueueOffline("entries.create", input, "temp-draft", "ws-a")).resolves.toBeUndefined();
    read.mockRestore();
    expect(await getOfflineQueue().list()).toHaveLength(1);
  });

  it("uses the captured account/server even after another account signs in", async () => {
    await setOfflineQueueOwner("user-b");
    await enqueueOffline("entries.create", input, "temp-draft", "ws-a", { owner: "user-a", server: "https://original.example" });
    expect(await getOfflineQueue().list()).toEqual([expect.objectContaining({ owner: "user-a", workspaceId: "ws-a", server: "https://original.example" })]);
  });
});
