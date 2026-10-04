// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { durableEntryEnvelope, durableQueuedWrite, OFFLINE_QUEUE_STORAGE_KEY } from "@starter/core";

vi.mock("@/lib/api-origin", () => ({
  rebaseApiUrl: (url: string) => url,
  getAbsoluteApiOrigin: () => "https://api.example.invalid",
  getDefaultAbsoluteApiOrigin: () => "https://api.example.invalid",
  whenApiOriginReady: async () => undefined,
}));
vi.mock("@/lib/active-workspace", () => ({
  isActiveWorkspaceReady: () => true,
  getActiveWorkspaceId: () => "workspace-1",
  getKnownWorkspaceIds: () => new Set(["workspace-1"]),
  whenActiveWorkspaceReady: async () => undefined,
  workspaceNameFor: () => "Synthetic",
}));
vi.mock("@/lib/server-level", () => ({ currentServerApiLevel: () => 12, noteClientTooOld: () => undefined }));
import { __resetOfflineQueueForTests, getOfflineQueue, retainDurableEntry, setOfflineQueueOwner, submitDurableEntry } from "./offline";

beforeEach(async () => {
  localStorage.clear();
  __resetOfflineQueueForTests();
  await setOfflineQueueOwner("user-1");
});

describe("the browser's durable write boundary", () => {
  it("saves before first send and survives a lost response without a second queued write", async () => {
    let first: Record<string, unknown> | undefined;
    let failure: unknown;
    try {
      await submitDurableEntry("entries.start", { description: "synthetic", __durableTempId: "temp-1" }, async (input) => {
        first = input;
        const stored = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)!);
        expect(stored.v).toBe(3);
        expect(stored.data[0].submittedInput).toEqual(input);
        expect(input).not.toHaveProperty("__durableTempId");
        throw new TypeError("synthetic lost response");
      });
    } catch (error) { failure = error; }
    expect(durableQueuedWrite(failure)).not.toBeNull();
    expect(await retainDurableEntry(failure, "temp-1")).toBe(true);
    __resetOfflineQueueForTests();
    const rows = await getOfflineQueue().list();
    expect(rows).toHaveLength(1);
    expect(rows[0].submittedInput).toEqual(first);
    expect(rows[0].payload).toMatchObject({ tempId: "temp-1" });
  });

  it("a full or unavailable store prevents HTTP", async () => {
    const send = vi.fn();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota exhausted"); };
    try {
      await expect(submitDurableEntry("entries.remove", { id: "entry-1" }, send)).rejects.toThrow("quota exhausted");
      expect(send).not.toHaveBeenCalled();
    } finally { Storage.prototype.setItem = original; }
  });

  it("refuses writes if shared storage ownership is unavailable", async () => {
    const manager = navigator.locks;
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const send = vi.fn();
    try {
      await expect(submitDurableEntry("entries.remove", { id: "entry-1" }, send)).rejects.toThrow("cannot safely save");
      expect(send).not.toHaveBeenCalled();
    } finally { Object.defineProperty(navigator, "locks", { configurable: true, value: manager }); }
  });
});


it("the real tRPC link sends only applyOperation and preserves its receipt after a lost response", async () => {
  const { getTRPCClient } = await import("./trpc");
  const requests: unknown[] = [];
  let committed = 0;
  const receiptIds = new Set<string>();
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init) => {
    expect(String(url)).toContain("entries.applyOperation");
    const envelope = JSON.parse(String(init?.body))["0"];
    requests.push(envelope);
    expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toContain(envelope.operationId);
    if (!receiptIds.has(envelope.operationId)) { receiptIds.add(envelope.operationId); committed += 1; }
    if (requests.length === 1) throw new TypeError("response lost after commit");
    return new Response(JSON.stringify([{ result: { data: { id: "entry-1" } } }]), { headers: { "content-type": "application/json" } });
  });
  try {
    const api = getTRPCClient({ streamQueries: false });
    await expect(api.entries.start.mutate({ description: "synthetic", source: "web", timeZone: "UTC" })).rejects.toThrow("waiting to sync");
    __resetOfflineQueueForTests();
    const report = await getOfflineQueue().flush(async (row) => {
      await api.entries.applyOperation.mutate(durableEntryEnvelope("entries.start", row.submittedInput!));
    });
    expect(report.flushed).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(committed).toBe(1);
  } finally { globalThis.fetch = original; }
});


it("a live caller-supplied operation ID still passes through durable storage", async () => {
  const { getTRPCClient } = await import("./trpc");
  const original = globalThis.fetch;
  const operationId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  let stored = false;
  globalThis.fetch = vi.fn(async () => {
    stored = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)?.includes(operationId) ?? false;
    return new Response(JSON.stringify([{ result: { data: { id: "entry-1" } } }]), { headers: { "content-type": "application/json" } });
  });
  try {
    await getTRPCClient({ streamQueries: false }).entries.remove.mutate({ id: "entry-1", operationId });
    expect(stored).toBe(true);
  } finally { globalThis.fetch = original; }
});
