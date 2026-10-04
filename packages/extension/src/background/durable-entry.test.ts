import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type OfflineOp } from "@starter/core";
import { saveSession } from "../lib/session";
let host: typeof import("./runtime");

const workspace = { id: "ws-fixture", name: "Synthetic", role: "owner", memberCount: 1, isDefault: true, permissions: {} };
const requests: Record<string, unknown>[] = [];
const receipts = new Map<string, unknown>();
let mode: "lost" | "ok" | "old" | "standalone" = "lost";
let writes = 0;
const entry = {
  id: "entry-fixture", workspaceId: workspace.id, authorId: "user-fixture", description: "Synthetic",
  projectId: null, taskId: null, billable: false, tagIds: [], start: "2026-10-04T00:00:00.000Z", end: null,
  durationSec: 0, hourlyRate: null, currency: "EUR", source: "extension", timeZone: "UTC", runaway: null,
  invoiceId: null, importId: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
};
const json = (data: unknown) => new Response(JSON.stringify({ result: { data } }));

beforeEach(async () => {
  vi.resetModules();
  host = await import("./runtime");
  requests.length = 0; receipts.clear(); writes = 0; mode = "lost";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api\/trpc\//, "");
    if (path === "/api/health") return new Response(JSON.stringify({ status: "ok", service: "trackyourtime", apiLevel: 12 }));
    if (path === "workspaces.list") return json([workspace]);
    if (init?.method !== "POST") return json(null);
    expect(path).toBe("entries.applyOperation");
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    // No queue access here: the sender holds the queue. Inspect its backing
    // store to prove persistence already completed before transport starts.
    const backing = await chrome.storage.local.get("trackyourtime.offline-queue");
    expect(JSON.stringify(backing)).toContain(String(request.operationId));
    if (mode === "old" || mode === "standalone") {
      const status = mode === "old" ? 404 : 412;
      return new Response(JSON.stringify({ error: {
        message: mode === "old" ? 'No procedure found on path "entries.applyOperation"' : "DURABLE_REPLAY_REQUIRES_REPLICA_SET",
        data: { code: mode === "old" ? "NOT_FOUND" : "PRECONDITION_FAILED", httpStatus: status },
      } }), { status });
    }
    const id = String(request.operationId);
    if (!receipts.has(id)) { receipts.set(id, entry); writes += 1; }
    if (mode === "lost") { mode = "ok"; throw new TypeError("committed response lost"); }
    return json(receipts.get(id));
  }));
  await saveSession({ token: "synthetic-token", userId: "user-fixture", email: "fixture@example.invalid" });
  await host.reload();
  await host.getOfflineQueue().clear();
  await host.resolveWorkspaces();
});

afterEach(() => vi.unstubAllGlobals());

test.each<OfflineOp>(["entries.start", "entries.stop", "entries.create", "entries.update", "entries.remove", "entries.discard"])("%s survives response loss and worker restart with one immutable receipt", async (op) => {
  let saved: unknown;
  try {
    await host.submitEntry(op, { id: "entry-fixture", description: "Synthetic", start: entry.start, end: "2026-10-04T00:01:00.000Z", originId: "fixture", workspaceId: workspace.id });
  } catch (error) { saved = error; }
  expect(saved).toMatchObject({ name: "DurableQueuedWriteError" });
  await host.enqueueOffline(op, {} as never, "temp-fixture", workspace.id, saved);
  expect(await host.getOfflineQueue().size()).toBe(1);
  await expect(host.cancelQueuedForTemp("temp-fixture")).rejects.toThrow("may already be saved");
  await host.reload();
  await host.flushQueue();
  expect(await host.getOfflineQueue().size()).toBe(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(writes).toBe(1);
});

test.each(["old", "standalone"] as const)("%s server holds the original request without falling back to a legacy write", async (serverMode) => {
  mode = serverMode;
  await expect(host.submitEntry("entries.remove", { id: "entry-fixture", workspaceId: workspace.id })).rejects.toThrow("waiting to sync");
  await host.flushQueue();
  const rows = await host.getOfflineQueue().list();
  expect(rows).toHaveLength(1);
  expect(rows[0].hold?.reason).toBe(serverMode === "old" ? "unknown-procedure" : "refused");
  expect(requests[0]).toEqual(requests[1]);
  expect(writes).toBe(0);
});


test("session refusal preserves saved writes for their owner and a different account cannot replay them", async () => {
  await expect(host.submitEntry("entries.create", { description: "Synthetic", start: entry.start, end: entry.start, workspaceId: workspace.id })).rejects.toThrow("waiting to sync");
  const original = (await host.getOfflineQueue().list())[0];
  await host.forgetSession();
  expect(await host.getOfflineQueue().list()).toEqual([original]);
  await saveSession({ token: "synthetic-other", userId: "user-other", email: "other@example.invalid" });
  await host.reload();
  await host.flushQueue();
  expect(requests).toHaveLength(1);
  expect(await host.getOfflineQueue().list()).toEqual([original]);
  await saveSession({ token: "synthetic-owner", userId: "user-fixture", email: "fixture@example.invalid" });
  await host.reload();
  await host.flushQueue();
  expect(await host.getOfflineQueue().size()).toBe(0);
  expect(requests[1]).toEqual(requests[0]);
  expect(writes).toBe(1);
});

test("queue storage refusal prevents the first HTTP write", async () => {
  const saved = chrome.storage.local.set;
  chrome.storage.local.set = vi.fn(async () => { throw new Error("quota exhausted"); });
  try {
    await expect(host.submitEntry("entries.remove", { id: entry.id, workspaceId: workspace.id })).rejects.toThrow("quota exhausted");
    expect(requests).toHaveLength(0);
  } finally { chrome.storage.local.set = saved; }
  expect(await host.getOfflineQueue().size()).toBe(0);
});

test("logout removes the stored token even when queue cleanup fails", async () => {
  const { loadSession } = await import("../lib/session");
  const saved = chrome.storage.local.get;
  chrome.storage.local.get = vi.fn(async () => { throw new Error("queue read failed"); });
  try { await expect(host.forgetSession()).rejects.toThrow("queue read failed"); }
  finally { chrome.storage.local.get = saved; }
  expect(await loadSession()).toBeNull();
  await host.reload();
  await expect(host.submitEntry("entries.remove", { id: entry.id, workspaceId: workspace.id })).rejects.toThrow("Sign in");
  expect(requests).toHaveLength(0);
});

test("logout reports token removal failure and fences in-memory senders", async () => {
  const saved = chrome.storage.session.remove;
  chrome.storage.session.remove = vi.fn(async () => { throw new Error("token removal failed"); });
  try { await expect(host.forgetSession()).rejects.toThrow("token removal failed"); }
  finally { chrome.storage.session.remove = saved; }
  await expect(host.submitEntry("entries.remove", { id: entry.id, workspaceId: workspace.id })).rejects.toThrow("Sign in");
  expect(requests).toHaveLength(0);
});
