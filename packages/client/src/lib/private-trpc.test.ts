// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUntypedClient } from "@trpc/client";
import { API_LEVEL, normalizeDisplayPreferences } from "@starter/shared";
import { OFFLINE_QUEUE_STORAGE_KEY } from "@starter/core";
import { privateRecoveryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", native: false, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, getDefaultAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: () => state.ready(), rebaseApiUrl: (url: string) => url }));
vi.mock("./active-workspace", () => ({ getActiveWorkspaceId: () => "workspace", isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {}, getKnownWorkspaceIds: () => new Set(["workspace"]), workspaceNameFor: () => "Synthetic workspace" }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => API_LEVEL, noteClientTooOld: () => {} }));
vi.mock("./native-session", () => ({ getNativeToken: () => null }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false, isTokenShell: () => state.native }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const offline = await import("./offline");
const { getTRPCClient } = await import("./trpc");
const { isPrivateContentRefusal } = await import("./private-content-error");
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin);
  state.native = false; state.ready = async () => {}; localStorage.clear(); session.lockPrivateData(); session.privateAccountChanged("owner");
  offline.__resetOfflineQueueForTests(); offline.__resetOfflineQueueOwnerForTests(); await offline.setOfflineQueueOwner("owner");
});
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const client = () => getUntypedClient(getTRPCClient({ streamQueries: false }));
it("serves real app catalog queries from the private replica without standard HTTP or a legacy queue", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const fetcher = vi.fn(() => { throw new Error("Unexpected standard transport"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), rows = await api.query("tags.list", {}) as { name: string }[];
  expect(rows.map((row) => row.name)).toEqual(["Another unsent private tag", "Unsent private rename"]);
  await expect(api.mutation("tags.create", { name: "Never send this private draft" })).rejects.toThrow("not available");
  await expect(api.mutation("entries.start", { description: "Never queue this private draft" })).rejects.toThrow("not available");
  expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]); expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
});
it("keeps privacy refusals out of the plaintext outbox even while the radio is offline", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const api = client(); let refusal;
  try { await api.mutation("entries.create", { description: "Private unsent description" }); } catch (error) { refusal = error; }
  expect(isPrivateContentRefusal(refusal)).toBe(true); expect(offline.isNetworkError(refusal)).toBe(false); expect(await offline.retainDurableEntry(refusal)).toBe(false);
  await expect(offline.enqueueOffline("entries.start", { description: "Private unsent description" } as never, undefined, "workspace")).rejects.toMatchObject({ privateContentRefusal: true });
  await expect(offline.submitDurableEntry("entries.start", { workspaceId: "workspace", description: "Private unsent description" }, async () => { throw new Error("Must not send"); })).rejects.toMatchObject({ privateContentRefusal: true });
  expect(await offline.getOfflineQueue().list()).toEqual([]); expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
});
it("preserves older plaintext work byte-for-byte while refusing replay and new edits to it", async () => {
  const row = { id: "old-row", op: "entries.start", payload: { input: { operationId: crypto.randomUUID(), description: "Original legacy draft", start: "2026-10-26T00:00:00.000Z" }, tempId: "temp-old" }, createdAt: "2026-10-26T00:00:00.000Z", owner: "owner", server: state.origin, workspaceId: "workspace", apiLevel: API_LEVEL };
  const raw = JSON.stringify({ v: 3, data: [row] }); localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, raw);
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const runner = vi.fn();
  const result = await offline.flushOfflineQueue(runner, { memberWorkspaceIds: new Set(["workspace"]) });
  expect(result.remaining).toBe(1); expect(isPrivateContentRefusal(result.error)).toBe(true); expect(runner).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBe(raw);
  await expect(offline.amendQueuedStart("temp-old", "2026-10-26T00:10:00.000Z", "workspace")).rejects.toMatchObject({ privateContentRefusal: true });
  expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBe(raw);
});
it("preserves ordinary standard workspace transport", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, input?: RequestInit) => {
    expect(input?.credentials).toBe("include");
    return new Response(JSON.stringify([{ result: { data: [{ id: "standard", name: "Standard tag" }] } }]), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  expect(await client().query("tags.list", {})).toEqual([{ id: "standard", name: "Standard tag" }]); expect(fetcher).toHaveBeenCalledOnce();
});
it("rechecks private policy after native readiness before dispatching a previously batched standard body", async () => {
  state.native = true; let calls = 0, resume!: () => void, enter!: () => void; const ready = new Promise<void>((resolve) => { enter = resolve; });
  state.ready = async () => { if (++calls === 2) { enter(); await new Promise<void>((resolve) => { resume = resolve; }); } };
  const fetcher = vi.fn(() => { throw new Error("Must not reach fetch"); }); vi.stubGlobal("fetch", fetcher);
  const pending = client().mutation("tags.create", { name: "Private draft waiting for native readiness" }); await ready;
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); resume(); await expect(pending).rejects.toThrow("cannot use the standard HTTP"); expect(fetcher).not.toHaveBeenCalled();
});

it("does not read or write a private running timer through the plaintext desktop mirror", async () => {
  state.native = true; await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const { readRunningMirror, writeRunningMirror } = await import("./running-mirror");
  const entry = { id: "entry", authorId: "owner", workspaceId: "workspace", description: "Private running task", projectId: null, taskId: null, billable: false, start: "2026-10-26T00:00:00.000Z", end: null, durationSec: 0, hourlyRate: null, currency: "EUR", source: "web", timeZone: "UTC", tagIds: [], invoiceId: null, importId: null, runaway: null, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" } as const;
  localStorage.setItem("trackyourtime.running-entry", JSON.stringify({ v: 1, data: entry })); expect(await readRunningMirror()).toBeNull(); expect(localStorage.getItem("trackyourtime.running-entry")).toBeNull();
  await writeRunningMirror({ ...entry, tagIds: [] }); expect(localStorage.getItem("trackyourtime.running-entry")).toBeNull();
});

it("does not expose raw private decoder values through a client error or its cause", async () => {
  const f = await privateRecoveryFixture(); f.archive.replica.pending[0]!.records[0]!.value.name = { privateNote: "Never include this private value in error reports" };
  await seedPrivateWorkspaceClient(f); let failure;
  try { await client().query("tags.list", {}); } catch (error) { failure = error; }
  expect(isPrivateContentRefusal(failure)).toBe(true); expect((failure as Error).message).toBe("Private workspace data could not be verified. Existing data was kept.");
  expect(JSON.stringify(failure)).not.toContain("Never include this private value");
});

it("reads private entry lists, details and suggestions locally while refusing the account-wide timer path", async () => {
  const f = await privateRecoveryFixture(), now = new Date().toISOString();
  f.archive.replica.pending[1]!.records.push({ kind: "entries", id: "private-entry", authorId: "owner", value: { _id: "private-entry", workspaceId: "workspace", authorId: "owner", description: "Private task [draft]", projectId: null, taskId: null, billable: true, start: now, end: now, durationSec: 1800, currency: "EUR", source: "desktop", createdAt: now, updatedAt: now } }, { kind: "entryMoney", id: "private-entry", authorId: "owner", value: { _id: "private-entry", workspaceId: "workspace", hourlyRate: 90 } });
  await seedPrivateWorkspaceClient(f); const fetcher = vi.fn(() => { throw new Error("Private entry must stay local"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), listed = await api.query("entries.list", { from: "2020-01-01", to: "2040-01-01", search: "[draft]" }) as { entries: { description: string; amount: number }[] };
  expect(listed.entries).toHaveLength(1); expect(listed.entries[0]).toMatchObject({ description: "Private task [draft]", amount: 45 });
  expect(await api.query("entries.get", { id: "private-entry" })).toMatchObject({ description: "Private task [draft]", hourlyRate: 90 });
  expect(await api.query("entries.recent", {})).toMatchObject([{ description: "Private task [draft]" }]);
  expect(await api.query("entries.descriptions", { search: "[draft]" })).toMatchObject([{ description: "Private task [draft]" }]);
  await expect(api.query("entries.current", {})).rejects.toThrow("not available"); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("reads only the current person's private favorites through the real client without standard transport", async () => {
 const f = await privateRecoveryFixture(), stamp = new Date().toISOString();
 f.archive.replica.pending[1]!.records.push({ kind: "favorites", id: "new-pin", authorId: "owner", value: { _id: "new-pin", workspaceId: "workspace", userId: "owner", description: "Private pinned work", projectId: null, taskId: null, billable: false, order: 0, createdAt: stamp, updatedAt: stamp } });
 await seedPrivateWorkspaceClient(f); const fetcher = vi.fn(() => { throw new Error("Private pins must stay local"); }); vi.stubGlobal("fetch", fetcher);
 expect(await client().query("favorites.list", {})).toMatchObject([{ id: "new-pin", description: "Private pinned work", projectName: null }]);
 await expect(client().mutation("favorites.create", { description: "Do not send" })).rejects.toThrow("not available"); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
 session.lockPrivateData(); await expect(client().query("favorites.list", {})).rejects.toThrow("Unlock"); expect(fetcher).not.toHaveBeenCalled();
});

it("joins private settings with a separate account-metadata request and reuses its encrypted copy offline", async () => {
 const f = await privateRecoveryFixture();
 f.archive.replica.pending[1]!.records.push({ kind: "settings", id: "settings", authorId: null, value: { _id: "settings", workspaceId: "workspace", currency: "AUD", weekStartsOn: 0 } }, { kind: "settingsMoney", id: "settings", authorId: null, value: { _id: "settings", workspaceId: "workspace", defaultHourlyRate: 125 } }, { kind: "members", id: "member", authorId: "owner", value: { _id: "member", workspaceId: "workspace", userId: "owner" } }, { kind: "memberMoney", id: "member", authorId: "owner", value: { _id: "member", workspaceId: "workspace", hourlyRate: 0 } });
 await seedPrivateWorkspaceClient(f);
 const fetcher = vi.fn(async (url: RequestInfo | URL, input?: RequestInit) => {
  expect(String(url)).toContain("/api/trpc/profile.displayPreferences"); expect(String(url)).not.toContain("settings.get"); expect(input?.cache).toBe("no-store"); expect(input?.redirect).toBe("error");
  return new Response(JSON.stringify({ result: { data: normalizeDisplayPreferences("owner", { theme: "dark", timeFormat: "12h" }) } }), { headers: { "content-type": "application/json" } });
 }); vi.stubGlobal("fetch", fetcher);
 const api = client(); expect(await api.query("settings.get", {})).toMatchObject({ currency: "AUD", weekStartsOn: 0, defaultHourlyRate: 125, memberHourlyRate: 0, theme: "dark", timeFormat: "12h" }); expect(fetcher).toHaveBeenCalledOnce();
 fetcher.mockRejectedValue(new TypeError("Failed to fetch")); expect(await api.query("settings.get", {})).toMatchObject({ currency: "AUD", defaultHourlyRate: 125, theme: "dark" }); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("reads the private business profile locally and keeps logo/profile writes out of the standard transport", async () => {
 const f = await privateRecoveryFixture(); f.archive.replica.pending[1]!.records.push({ kind: "businessProfile", id: "profile", authorId: null, value: { _id: "profile", workspaceId: "workspace", legalName: "Private studio", paymentDetails: "Private bank details" } });
 await seedPrivateWorkspaceClient(f); const fetcher = vi.fn(() => { throw new Error("Private business identity must stay local"); }); vi.stubGlobal("fetch", fetcher);
 expect(await client().query("settings.businessProfile", {})).toMatchObject({ legalName: "Private studio", paymentDetails: "Private bank details", logo: null, updatedAt: null });
 await expect(client().mutation("settings.updateBusinessProfile", { legalName: "Do not send" })).rejects.toThrow("not available"); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("calculates private all-time bounds locally without finance fields or standard report filters leaving the device", async () => {
 const f = await privateRecoveryFixture(); f.archive.replica.pending[1]!.records.push({ kind: "entries", id: "span-entry", authorId: "owner", value: { _id: "span-entry", workspaceId: "workspace", authorId: "owner", start: "2026-08-21T23:30:00.000Z" } }); await seedPrivateWorkspaceClient(f);
 const fetcher = vi.fn(() => { throw new Error("Private report bounds must stay local"); }); vi.stubGlobal("fetch", fetcher);
 expect(await client().query("reports.trackedSpan", { timeZone: "Europe/Berlin", memberIds: ["owner"] })).toMatchObject({ from: "2026-08-22" }); expect(fetcher).not.toHaveBeenCalled();
});

it("runs private report pages, totals, summaries and weekly grids through the real client without HTTP or plaintext exports", async () => {
 const f = await privateRecoveryFixture(), stamp = "2026-10-01T09:00:00.000Z", entryId = "64b7f9c2e13a4d5f6a7b8d99";
 f.archive.replica.pending[1]!.records.push({ kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Private report [draft]", projectId: null, taskId: null, billable: true, start: stamp, end: "2026-10-01T10:00:00.000Z", durationSec: 3600, currency: "EUR", source: "desktop", createdAt: stamp, updatedAt: stamp } }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 90 } });
 await seedPrivateWorkspaceClient(f);
 const fetcher = vi.fn(() => { throw new Error("Private report filters must stay local"); }); vi.stubGlobal("fetch", fetcher);
 const api = client(), filters = { from: "2026-10-01", to: "2026-10-07", timeZone: "UTC", search: "[draft]" };
 expect(await api.query("reports.rows", filters)).toMatchObject({ entries: [{ id: entryId, amount: 90, durationSec: 3600 }] });
 expect(await api.query("reports.totals", filters)).toMatchObject({ totalSec: 3600, totalAmount: 90 });
 expect(await api.query("reports.detailed", filters)).toMatchObject({ entries: [{ id: entryId }], totalAmount: 90 });
 expect(await api.query("reports.summary", { ...filters, groupBy: "project" })).toMatchObject({ totalSec: 3600, groups: [{ label: "No project" }] });
 expect(await api.query("reports.weekly", { ...filters, weekStart: "2026-10-01" })).toMatchObject({ totalSec: 3600, dayTotals: [3600, 0, 0, 0, 0, 0, 0] });
 const { fetchReportExport, exportReportFile } = await import("./report-export"), legacy = vi.fn();
 const exportInput = { ...filters, report: "detailed" as const };
 await expect(fetchReportExport("csv", exportInput)).rejects.toThrow("Server export is refused");
 await expect(exportReportFile("pdf", exportInput, legacy)).rejects.toThrow("Server export is refused");
 expect(fetcher).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
 session.lockPrivateData(); await expect(api.query("reports.summary", { ...filters, groupBy: "day" })).rejects.toThrow("Unlock private data");
 expect(fetcher).not.toHaveBeenCalled();
});
