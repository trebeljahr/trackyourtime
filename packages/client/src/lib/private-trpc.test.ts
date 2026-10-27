// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUntypedClient } from "@trpc/client";
import { API_LEVEL, BUSINESS_LOGO_REFUSALS, normalizeDisplayPreferences } from "@starter/shared";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, privateWorkspaceChainRoot, OFFLINE_QUEUE_STORAGE_KEY, createTempId } from "@starter/core";
import { privateRecoveryFixture, privateManualEntryFixture, seedPrivateWorkspaceClient } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", native: false, tokenRevision: 0, ready: async () => {} }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, getAbsoluteApiOrigin: () => state.origin, getDefaultAbsoluteApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {}, whenApiOriginReady: () => state.ready(), rebaseApiUrl: (url: string) => url }));
vi.mock("./active-workspace", () => ({ getActiveWorkspaceId: () => "workspace", subscribeActiveWorkspace: () => () => {}, isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {}, getKnownWorkspaceIds: () => new Set(["workspace"]), getKnownWorkspacesOwner: () => "owner", getActiveWorkspaceSnapshot: () => ({ activeId: "workspace", workspaces: null }), workspaceNameFor: () => "Synthetic workspace" }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./server-level", () => ({ currentServerApiLevel: () => API_LEVEL, noteClientTooOld: () => {} }));
vi.mock("./native-session", () => ({ getNativeToken: () => null, getNativeTokenRevision: () => state.tokenRevision }));
vi.mock("./shell", () => ({ clientId: () => "web", isCapacitor: () => false, isTokenShell: () => state.native }));
vi.mock("./app-query-persistence", () => ({ getQueryPersistence: () => ({ forget: async () => {}, protectPrivateAccount: async () => {} }) }));
vi.mock("./catalog-cache", () => ({ bindCatalogCaches: () => {} }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
const session = await import("./private-session");
const offline = await import("./offline");
const { getTRPCClient } = await import("./trpc");
const { isPrivateContentRefusal } = await import("./private-content-error");
const { confirmStandardDeviceAccess } = await import("./private-device-access");
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubEnv("NEXT_PUBLIC_API_URL", state.origin);
  state.native = false; state.tokenRevision = 0; state.ready = async () => {}; localStorage.clear(); session.lockPrivateData(); session.privateAccountChanged("owner");
  offline.__resetOfflineQueueForTests(); offline.__resetOfflineQueueOwnerForTests(); await offline.setOfflineQueueOwner("owner");
});
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const client = () => getUntypedClient(getTRPCClient({ streamQueries: false }));
it("keeps a first login on an unknown device out of standard HTTP and the plaintext outbox", async () => {
  const fetcher = vi.fn(() => { throw new Error("A server claim must not choose standard mode"); }); vi.stubGlobal("fetch", fetcher);
  await expect(client().query("workspaces.list")).rejects.toThrow("confirm standard storage");
  await expect(client().query("tags.list", {})).rejects.toThrow("confirm standard storage");
  await expect(client().mutation("entries.start", { description: "Private draft before device trust" })).rejects.toThrow("confirm standard storage");
  expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]); expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
});
it("never treats a recovered root on a cleared device as proof that workspace data is standard", async () => {
  const f = await privateRecoveryFixture(); await session.unlockPrivateRecovery("owner", { ...f.identity, passkeys: [] }, f.recoveryKey);
  const fetcher = vi.fn(() => { throw new Error("Untrusted root must not select standard HTTP"); }); vi.stubGlobal("fetch", fetcher);
  await expect(client().query("tags.list", {})).rejects.toThrow("inventory is missing");
  await expect(client().mutation("entries.start", { description: "Must stay private" })).rejects.toThrow("inventory is missing");
  expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("serves verified private workspace names and permissions through the real account-wide client without HTTP", async () => {
  const f = await privateRecoveryFixture();
  f.archive.replica.pending[1]!.records.push({ kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: "workspace", organization: { _id: "workspace", name: "Trusted private studio", kind: "team" } } });
  await seedPrivateWorkspaceClient(f); const fetcher = vi.fn(() => { throw new Error("Navigation must stay local"); }); vi.stubGlobal("fetch", fetcher);
  expect(await client().query("workspaces.list")).toMatchObject([{ id: "workspace", name: "Trusted private studio", role: "owner", memberCount: 1, permissions: { inviteMembers: true } }]);
  expect(fetcher).not.toHaveBeenCalled();
});
it("serves real app catalog queries from the private replica without standard HTTP or a legacy queue", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const fetcher = vi.fn(() => { throw new Error("Unexpected standard transport"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), rows = await api.query("tags.list", {}) as { name: string }[];
  expect(rows.map((row) => row.name)).toEqual(["Another unsent private tag", "Unsent private rename"]);
  expect(await api.mutation("tags.create", { name: "Never send this private draft" })).toMatchObject({ name: "Never send this private draft", createdBy: "owner" });
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
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, input?: RequestInit) => {
    expect(input?.credentials).toBe("include"); expect(new Headers(input?.headers).has("x-trackyourtime-local-scope")).toBe(false);
    return new Response(JSON.stringify([{ result: { data: [{ id: "standard", name: "Standard tag" }] } }]), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  expect(await client().query("tags.list", {})).toEqual([{ id: "standard", name: "Standard tag" }]); expect(fetcher).toHaveBeenCalledOnce();
});
it("never sends caller filters through the account-wide workspace metadata request", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const privateFilter = "Private description must never become account metadata";
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(decodeURIComponent(String(url)) + String(init?.body)).not.toContain(privateFilter);
    return new Response(JSON.stringify([{ result: { data: [{ id: "standard", name: "Standard workspace" }] } }]), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  expect(await client().query("workspaces.list", { search: privateFilter })).toMatchObject([{ id: "standard" }]); expect(fetcher).toHaveBeenCalledOnce();
});
it("rechecks private policy after native readiness before dispatching a previously batched standard body", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  state.native = true; let calls = 0, resume!: () => void, enter!: () => void; const ready = new Promise<void>((resolve) => { enter = resolve; });
  state.ready = async () => { if (++calls === 2) { enter(); await new Promise<void>((resolve) => { resume = resolve; }); } };
  const fetcher = vi.fn(() => { throw new Error("Must not reach fetch"); }); vi.stubGlobal("fetch", fetcher);
  const pending = client().mutation("tags.create", { name: "Private draft waiting for native readiness" }); await ready;
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); resume(); await expect(pending).rejects.toThrow("cannot use the standard HTTP"); expect(fetcher).not.toHaveBeenCalled();
});
it("never dispatches an earlier account's body after a native readiness wait changes the signed-in account", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true);
  state.native = true; let calls = 0, resume!: () => void, enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  state.ready = async () => { if (++calls === 2) { enter(); await new Promise<void>((resolve) => { resume = resolve; }); } };
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ result: { data: { id: "created" } } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  const pending = client().mutation("tags.create", { name: "Original account draft" }); await entered; session.privateAccountChanged("other"); resume();
  await expect(pending).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it("never dispatches an earlier draft after the native credential changes during readiness", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true); state.native = true;
  let resume!: () => void, paused!: () => void, calls = 0;
  const waiting = new Promise<void>((resolve) => { paused = resolve; });
  state.ready = async () => { if (++calls === 2) { paused(); await new Promise<void>((resolve) => { resume = resolve; }); } };
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ result: { data: {} } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  const pending = client().mutation("tags.create", { name: "Credential-bound draft" });
  await waiting; state.tokenRevision++; resume();
  await expect(pending).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
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
 expect(await client().mutation("favorites.create", { description: "Saved private pin" })).toMatchObject({ description: "Saved private pin", order: 1 }); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
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
 fetcher.mockRejectedValue(new TypeError("Failed to fetch")); expect(await api.query("settings.get", {})).toMatchObject({ currency: "AUD", defaultHourlyRate: 125, theme: "dark" });
 expect(await api.mutation("settings.update", { currency: "USD", defaultHourlyRate: 0, weekStartsOn: 1 })).toMatchObject({ currency: "USD", defaultHourlyRate: 0, weekStartsOn: 1, memberHourlyRate: 0, theme: "dark" });
 await expect(api.mutation("settings.update", { currency: "GBP", theme: "light" })).rejects.toThrow("could not be confirmed");
 expect(await api.query("settings.get", {})).toMatchObject({ currency: "USD", defaultHourlyRate: 0, theme: "dark" }); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("reads the private business profile locally and keeps logo/profile writes out of the standard transport", async () => {
 const f = await privateRecoveryFixture(); f.archive.replica.pending[1]!.records.push({ kind: "businessProfile", id: "profile", authorId: null, value: { _id: "profile", workspaceId: "workspace", legalName: "Private studio", paymentDetails: "Private bank details" } });
 await seedPrivateWorkspaceClient(f); const fetcher = vi.fn(() => { throw new Error("Private business identity must stay local"); }); vi.stubGlobal("fetch", fetcher);
 expect(await client().query("settings.businessProfile", {})).toMatchObject({ legalName: "Private studio", paymentDetails: "Private bank details", logo: null, updatedAt: null });
 expect(await client().mutation("settings.updateBusinessProfile", { legalName: "Encrypted saved issuer" })).toMatchObject({ legalName: "Encrypted saved issuer", paymentDetails: "Private bank details" });
 const png = readFileSync("../server/src/tests/fixtures/logo/rgba.png"), saved = await client().mutation("settings.setBusinessLogo", { mime: "image/png", base64: png.toString("base64") }) as { updatedAt: string; logo: unknown };
 expect(saved.logo).not.toBeNull();
 await expect(client().mutation("settings.setBusinessLogo", { mime: "image/jpeg", base64: png.toString("base64") })).rejects.toThrow(BUSINESS_LOGO_REFUSALS.unsupportedFormat);
 const { capturePrivateWorkspaceRecovery } = await import("./private-workspace-session"), archive = await capturePrivateWorkspaceRecovery("owner", "workspace", f.identity);
 expect(archive.replica.pending.some(operation => operation.records.some(row => row.kind === "businessProfile" && JSON.stringify(row.value).includes(png.toString("base64"))))).toBe(true);
 expect(await client().mutation("settings.clearBusinessLogo", {})).toMatchObject({ legalName: "Encrypted saved issuer", updatedAt: saved.updatedAt, logo: null });
 expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
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
 const csv = await exportReportFile("csv", exportInput, legacy), pdf = await exportReportFile("pdf", exportInput, legacy);
 const readBlob = (blob: Blob, binary = false) => new Promise<string | ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string | ArrayBuffer); reader.onerror = () => reject(reader.error); if (binary) reader.readAsArrayBuffer(blob); else reader.readAsText(blob); });
 expect(await readBlob(csv.blob)).toContain("Private report [draft]"); expect(csv.filename).toBe("trackyourtime-detailed-2026-10-01_2026-10-07.csv");
 const bytes = new Uint8Array(await readBlob(pdf.blob, true) as ArrayBuffer); expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-"); expect(pdf.filename.endsWith(".pdf")).toBe(true);
 expect(fetcher).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
 session.lockPrivateData(); await expect(api.query("reports.summary", { ...filters, groupBy: "day" })).rejects.toThrow("Unlock private data");
 expect(fetcher).not.toHaveBeenCalled();
}, 30000);

it("discards an unfinished local PDF after locking without falling back or queuing plaintext", async () => {
 await seedPrivateWorkspaceClient(await privateRecoveryFixture());
 const fetcher = vi.fn(() => { throw new Error("No network"); }); vi.stubGlobal("fetch", fetcher);
 const pdf = await import("@starter/invoice-pdf/report-pdf"), original = pdf.renderSummaryPdf;
 let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
 const render = vi.spyOn(pdf, "renderSummaryPdf").mockImplementation(async (...args) => { await gate; return original(...args); });
 const { exportReportFile } = await import("./report-export"), legacy = vi.fn();
 const result = exportReportFile("pdf", { from: "2026-10-01", to: "2026-10-07", report: "summary", groupBy: "project", timeZone: "UTC" }, legacy);
 await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1)); session.lockPrivateData(); release();
 await expect(result).rejects.toMatchObject({ privateContentRefusal: true });
 expect(fetcher).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
}, 30000);

it("joins private members and member report labels with separate account metadata without sending report filters", async () => {
 const f = await privateRecoveryFixture(), stamp = "2026-10-01T09:00:00.000Z", entryId = "64b7f9c2e13a4d5f6a7b8d77";
 f.archive.replica.pending[1]!.records.push({ kind: "members", id: "member", authorId: "owner", value: { _id: "member", workspaceId: "workspace", userId: "owner", name: "Original name", role: "member", canViewOthersMoney: false, createdAt: stamp } }, { kind: "memberMoney", id: "member", authorId: "owner", value: { _id: "member", hourlyRate: 0 } }, { kind: "entries", id: entryId, authorId: "owner", value: { _id: entryId, workspaceId: "workspace", authorId: "owner", description: "Private member report filter", projectId: null, taskId: null, billable: true, start: stamp, end: "2026-10-01T10:00:00.000Z", durationSec: 3600, currency: "EUR", source: "web", createdAt: stamp, updatedAt: stamp } }, { kind: "entryMoney", id: entryId, authorId: "owner", value: { _id: entryId, hourlyRate: 90 } });
 await seedPrivateWorkspaceClient(f);
 const fetcher = vi.fn(async (url: unknown) => {
  const target = new URL(String(url)); expect(target.origin).toBe(state.origin); expect(target.pathname).toBe("/api/trpc/profile.workspaceMemberMetadata"); expect(JSON.parse(target.searchParams.get("input")!)).toEqual({ workspaceId: "workspace" });
  return Response.json({ result: { data: { workspaceId: "workspace", userId: "owner", members: [{ userId: "owner", memberId: "auth-owner", name: "Current account name", email: "owner@example.test" }] } } });
 }); vi.stubGlobal("fetch", fetcher);
 const api = client(); expect(await api.query("members.list", {})).toMatchObject([{ userId: "owner", memberId: "member", name: "Current account name", role: "owner", canViewOthersMoney: true, hourlyRate: 0 }]);
 expect(await api.query("reports.summary", { from: "2026-10-01", to: "2026-10-01", groupBy: "member", search: "Private member report filter", timeZone: "UTC" })).toMatchObject({ groups: [{ label: "Current account name", seconds: 3600 }] });
 expect(fetcher).toHaveBeenCalledTimes(2); await expect(api.mutation("members.updateVisibility", { memberId: "auth-owner", canViewOthersMoney: true })).rejects.toThrow("not available"); expect(fetcher).toHaveBeenCalledTimes(2); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("atomically creates, reorders and removes private favorites through the real app client with no HTTP or legacy storage", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const fetcher = vi.fn(() => { throw new Error("Private edits must stay encrypted and local until sync"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), [first, duplicate] = await Promise.all([api.mutation("favorites.create", { description: "Same private pin" }), api.mutation("favorites.create", { description: " Same private pin " })]) as { id: string }[];
  expect(first!.id).toBe(duplicate!.id);
  const second = await api.mutation("favorites.create", { description: "Second pin" }) as { id: string };
  expect(await api.mutation("favorites.reorder", { ids: [second.id, "foreign"] })).toMatchObject([{ id: second.id, order: 0 }, { id: first!.id, order: 1 }]);
  expect(await api.mutation("favorites.remove", { id: second.id })).toEqual({ success: true, id: second.id });
  expect(await api.query("favorites.list", {})).toMatchObject([{ id: first!.id, order: 0 }]); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
  session.lockPrivateData(); await expect(api.mutation("favorites.create", { description: "Locked draft" })).rejects.toThrow("Unlock");
});

function servePrivateJournal(initial: Awaited<ReturnType<typeof privateRecoveryFixture>>, loseReply = false) {
  const journal: import("@starter/shared").PrivateChainedWorkspaceChange[] = [], requests: string[] = [];
  let lost = false;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname.split("/").at(-1), raw = init?.body ?? target.searchParams.get("input"), input = JSON.parse(String(raw));
    expect(target.origin).toBe(state.origin); expect(init?.cache).toBe("no-store"); expect(init?.redirect).toBe("error"); expect(input.workspaceId).toBe("workspace");
    expect(String(raw)).not.toContain("Private pin queued for sync"); expect(String(raw)).not.toContain(initial.secrets.master); expect(new Headers(init?.headers).has("x-trackyourtime-local-scope")).toBe(false); requests.push(path!);
    let data;
    if (path === "privacy.chainedChanges") {
      const through = input.through ?? journal.length + 1;
      data = { through, next: null, changes: journal.filter((row) => row.revision > input.after && row.revision <= through) };
    } else {
      expect(path).toBe("privacy.chainedWrite"); expect(input.edit.expectedRevision).toBe(journal.length + 1);
      const { workspaceId: _scope, ...signed } = input; void _scope;
      const manifest = privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner");
      journal.push({ revision: journal.length + 2, manifest, signature: signed.readerSignatures.find((row: { userId: string }) => row.userId === "owner").signature, records: signed.edit.records, chain: signed.chain });
      data = { revision: journal.length + 1, head: await privateWorkspaceChainRoot(signed.chain) };
      if (loseReply && !lost) { lost = true; throw new TypeError("Lost private sync reply"); }
    }
    return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher); return { journal, requests, fetcher };
}
it("delivers locally saved private favorites only through signed ciphertext and reports verified completion", async () => {
  const f = await privateRecoveryFixture(); await seedPrivateWorkspaceClient(f);
  await client().mutation("favorites.create", { description: "Private pin queued for sync" });
  const wire = servePrivateJournal(f), { syncPrivateWorkspace } = await import("./private-workspace-sync"), states: unknown[] = [];
  expect(await syncPrivateWorkspace({ server: state.origin, userId: "owner", workspaceId: "workspace" }, (state) => states.push(state), () => true)).toEqual({ changed: true });
  expect(states.at(-1)).toEqual({ phase: "saved", pending: 0 }); expect(wire.journal).toHaveLength(3); expect(wire.requests.every((path) => ["privacy.chainedChanges", "privacy.chainedWrite"].includes(path))).toBe(true);
  expect(await client().query("favorites.list", {})).toMatchObject([{ description: "Private pin queued for sync" }]); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
it("keeps the exact pending private queue after a lost reply and recovers through authenticated history", async () => {
  const f = await privateRecoveryFixture(); await seedPrivateWorkspaceClient(f); await client().mutation("favorites.create", { description: "Private pin queued for sync" });
  const wire = servePrivateJournal(f, true), { syncPrivateWorkspace } = await import("./private-workspace-sync"), states: unknown[] = [], scope = { server: state.origin, userId: "owner", workspaceId: "workspace" };
  await syncPrivateWorkspace(scope, (state) => states.push(state), () => true); expect(states.at(-1)).toEqual({ phase: "unavailable", pending: 3 });
  expect(await client().query("favorites.list", {})).toMatchObject([{ description: "Private pin queued for sync" }]);
  await syncPrivateWorkspace(scope, (state) => states.push(state), () => true); expect(states.at(-1)).toEqual({ phase: "saved", pending: 0 }); expect(wire.journal).toHaveLength(3);
});
it("keeps pending edits visible when the guarded server refuses encrypted writes", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await client().mutation("favorites.create", { description: "Guarded local pin" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Internal protocol closed", code: -32603, data: { code: "NOT_IMPLEMENTED", httpStatus: 501 } } }), { status: 501, headers: { "content-type": "application/json" } })));
  const { syncPrivateWorkspace } = await import("./private-workspace-sync"), states: unknown[] = [];
  await syncPrivateWorkspace({ server: state.origin, userId: "owner", workspaceId: "workspace" }, (state) => states.push(state), () => true);
  expect(states.at(-1)).toEqual({ phase: "unavailable", pending: 3 }); expect(await client().query("favorites.list", {})).toMatchObject([{ description: "Guarded local pin" }]);
});

it("wakes other windows using public scope only and ignores malformed or foreign-shaped notifications", async () => {
  class Channel { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage = vi.fn(); close = vi.fn(); constructor() { channels.push(this); } }
  const channels: Channel[] = [];
  vi.stubGlobal("BroadcastChannel", Channel);
  const { subscribePrivateWorkspaceEdits, notifyPrivateWorkspaceEdit } = await import("./private-workspace-sync"), listener = vi.fn(), unsubscribe = subscribePrivateWorkspaceEdits(listener), scope = { server: state.origin, userId: "owner", workspaceId: "workspace" };
  const opened = channels[0]!;
  notifyPrivateWorkspaceEdit(scope); expect(listener).toHaveBeenCalledWith(scope); expect(opened!.postMessage).toHaveBeenCalledWith(scope);
  opened!.onmessage!({ data: { ...scope, description: "Unexpected private value" } }); expect(listener).toHaveBeenCalledTimes(1);
  opened!.onmessage!({ data: { ...scope, server: "file:///private" } }); expect(listener).toHaveBeenCalledTimes(1);
  opened!.onmessage!({ data: scope }); expect(listener).toHaveBeenCalledTimes(2); unsubscribe(); expect(opened!.close).toHaveBeenCalledOnce();
});

it("edits private shared catalogs atomically with paired money records and no standard requests", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const fetcher = vi.fn(() => { throw new Error("Private catalog must not use standard HTTP"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), clientRow = await api.mutation("clients.create", { name: "Private client", billing: { legalName: "Private billing name" } }) as { id: string };
  const project = await api.mutation("projects.create", { name: "Private project", clientId: clientRow.id, hourlyRate: 120, budgetAmount: 1000, budgetCurrency: "EUR" }) as { id: string };
  expect(await api.mutation("projects.update", { id: project.id, name: "Renamed project", hourlyRate: 0, applyToEntries: false })).toMatchObject({ name: "Renamed project", billableDefault: false, entriesRewritten: null });
  const task = await api.mutation("tasks.create", { name: "Private task" }) as { id: string };
  expect(await api.mutation("tasks.archive", { id: task.id })).toMatchObject({ archived: true });
  const results = await Promise.allSettled([api.mutation("tags.create", { name: "Atomic name" }), api.mutation("tags.create", { name: "atomic name" })]); expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(await api.query("clients.options", { includeArchived: true })).toMatchObject([{ id: clientRow.id, billing: { legalName: "Private billing name" } }]);
  await expect(api.mutation("projects.update", { id: project.id, clientId: null })).rejects.toThrow("could not be confirmed");
  await expect(api.mutation("tags.remove", { id: "tag" })).rejects.toThrow("not available"); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("never runs an earlier form draft under a new account after React Query's optimistic hook was awaiting", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); await client().query("tags.list", {});
  await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true);
  const { createAppQueryClient } = await import("./query-client"), queryClient = createAppQueryClient();
  let enter!: () => void, resume!: () => void; const waiting = new Promise<void>((resolve) => { enter = resolve; });
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationKey: [["tags", "create"]], networkMode: "always", onMutate: async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); }, mutationFn: (input: { name: string }) => client().mutation("tags.create", input) });
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ result: { data: { id: "foreign", name: "Earlier private draft" } } }]), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
  const pending = mutation.execute({ name: "Earlier private draft" }); await waiting; session.privateAccountChanged("other"); resume();
  await expect(pending).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); queryClient.clear();
});

it("freezes form intent before an optimistic hook and retains it when React Query options are replaced", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const { createAppQueryClient } = await import("./query-client"), queryClient = createAppQueryClient();
  let enter!: () => void, resume!: () => void; const waiting = new Promise<void>((resolve) => { enter = resolve; });
  const mutationFn = (input: { name: string }) => client().mutation("tags.create", input);
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationKey: [["tags", "create"]], networkMode: "always", onMutate: async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); }, mutationFn });
  const variables = { name: "Original private form" }, pending = mutation.execute(variables); await waiting; variables.name = "Changed while waiting";
  mutation.setOptions({ ...mutation.options, mutationFn }); resume(); expect(await pending).toMatchObject({ name: "Original private form" }); queryClient.clear();
});
it("does not let concurrent reuse of one variables object overwrite an earlier form's identity binding", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const { createAppQueryClient } = await import("./query-client"), queryClient = createAppQueryClient();
  let enter!: () => void, resume!: () => void; const waiting = new Promise<void>((resolve) => { enter = resolve; }), variables = { name: "Earlier guarded form" };
  const first = queryClient.getMutationCache().build(queryClient, { mutationKey: [["tags", "create"]], networkMode: "always", onMutate: async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); }, mutationFn: (input: { name: string }) => client().mutation("tags.create", input) });
  const pending = first.execute(variables); await waiting;
  const duplicate = queryClient.getMutationCache().build(queryClient, { mutationKey: [["tags", "create"]], networkMode: "always", mutationFn: (input: { name: string }) => client().mutation("tags.create", input) }); await expect(duplicate.execute(variables)).rejects.toThrow("already being saved");
  await confirmStandardDeviceAccess({ server: state.origin, userId: "other" }, () => true); session.privateAccountChanged("other"); resume();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(pending).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); queryClient.clear();
});

it("preserves timer metadata attached by an optimistic hook while freezing the original business input", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const { createAppQueryClient } = await import("./query-client"), { assignPrivateMutationMetadata } = await import("./private-mutation-guard"), queryClient = createAppQueryClient(), tempId = createTempId();
  const variables = { description: "Original timer intent", start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T01:00:00.000Z", billable: false };
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationKey: [["entries", "create"]], networkMode: "always", onMutate: async (raw: typeof variables) => {
    assignPrivateMutationMetadata(raw, { __durableScope: { owner: "owner", server: state.origin, workspaceId: "workspace" }, __durableTempId: tempId }); raw.description = "Changed by an optimistic hook";
  }, mutationFn: (input: typeof variables) => client().mutation("entries.create", input) });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Synthetic connection lost"); })); await expect(mutation.execute(variables)).rejects.toThrow();
  const rows = await offline.getOfflineQueue().list(); expect(rows).toHaveLength(1); expect(rows[0]!.payload).toMatchObject({ tempId, input: { description: "Original timer intent" } }); queryClient.clear();
});
it("refuses generated timer metadata for another account or workspace before the standard queue can store it", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true);
  const { createAppQueryClient } = await import("./query-client"), { assignPrivateMutationMetadata } = await import("./private-mutation-guard"), queryClient = createAppQueryClient(), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationKey: [["entries", "start"]], networkMode: "always", onMutate: async (raw: { description: string }) => { assignPrivateMutationMetadata(raw, { __durableScope: { owner: "other", server: state.origin, workspaceId: "workspace" } }); }, mutationFn: (input: { description: string }) => client().mutation("entries.start", input) });
  await expect(mutation.execute({ description: "Must stay in the original account" })).rejects.toThrow("another account or workspace"); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]); queryClient.clear();
});

it("saves, edits and removes completed private time through the real client without standard HTTP or outbox", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); const fetcher = vi.fn(() => { throw new Error("Private entry must stay local"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), { isPrivateLocalResult } = await import("./private-local-result");
  const created = await api.mutation("entries.create", { description: "Confidential manual time", start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z", billable: true, tagIds: ["tag"], __durableScope: { owner: "owner", server: state.origin, workspaceId: "workspace" }, __durableTempId: createTempId() }) as { id: string; hourlyRate: number; description: string };
  expect(created).toMatchObject({ description: "Confidential manual time", hourlyRate: 60, durationSec: 3600 }); expect(isPrivateLocalResult(created)).toBe(true);
  const [renamed, retagged] = await Promise.all([api.mutation("entries.update", { id: created.id, description: "Renamed confidential time" }), api.mutation("entries.update", { id: created.id, tagIds: [] })]);
  expect(renamed).toMatchObject({ id: created.id }); expect(retagged).toMatchObject({ id: created.id });
  expect(await api.query("entries.get", { id: created.id })).toMatchObject({ description: "Renamed confidential time", tagIds: [], hourlyRate: 60 });
  expect(await api.mutation("entries.remove", { id: created.id })).toEqual({ success: true, id: created.id });
  await expect(api.query("entries.get", { id: created.id })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]); expect(localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
});
it("refuses foreign private entry provenance and standard queued identities before appending local work", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { openPrivateWorkspaceSyncSession } = await import("./private-workspace-session"), copy = await openPrivateWorkspaceSyncSession("owner", "workspace");
  try {
    const before = await copy.checkpoint(), input = { description: "Keep this original intent", start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z", billable: false };
    await expect(client().mutation("entries.create", { ...input, __durableScope: { owner: "other", server: state.origin, workspaceId: "workspace" } })).rejects.toThrow("scope changed");
    await expect(client().mutation("entries.create", { ...input, operationId: crypto.randomUUID() })).rejects.toThrow();
    expect(await copy.checkpoint()).toEqual(before); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
  } finally { copy.close(); }
});

it("sends only scoped navigation metadata for a private workspace and strips extra server result fields", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toContain("workspaces.setActive"); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toEqual({ "0": { workspaceId: "workspace" } });
    expect(new Headers(init?.headers).has("x-trackyourtime-local-scope")).toBe(false);
    return new Response(JSON.stringify([{ result: { data: { workspaceId: "workspace", name: "Untrusted server name", permissions: { invoices: true } } } }]), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher);
  expect(await client().mutation("workspaces.setActive", { workspaceId: "workspace" })).toEqual({ workspaceId: "workspace" }); expect(fetcher).toHaveBeenCalledOnce();
});
it("refuses content smuggled into workspace selection, unknown inventory targets and different server acknowledgements", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture()); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(client().mutation("workspaces.setActive", { workspaceId: "workspace", name: "Private draft must stay here" })).rejects.toThrow("metadata");
  await expect(client().mutation("workspaces.setActive", { workspaceId: "foreign" })).rejects.toThrow();
  await expect(client().query("workspaces.setActive", { workspaceId: "workspace" })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockImplementation(async () => new Response(JSON.stringify([{ result: { data: { workspaceId: "foreign" } } }]), { headers: { "content-type": "application/json" } }));
  await expect(client().mutation("workspaces.setActive", { workspaceId: "workspace" })).rejects.toThrow("different workspace");
});
it("does not let workspace-selection metadata open a private content batch at the final HTTP boundary", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const { assertStandardContentRequest } = await import("./private-content-route"), { capturePrivateRequestScope, LOCAL_REQUEST_SCOPE_HEADER } = await import("./private-request-scope");
  const original = capturePrivateRequestScope();
  const init = { method: "POST", headers: { [LOCAL_REQUEST_SCOPE_HEADER]: JSON.stringify([[original, null], [original, null]]) }, body: JSON.stringify({ "0": { workspaceId: "workspace" }, "1": { workspaceId: "workspace", name: "Must never reach the server" } }) };
  await expect(assertStandardContentRequest(state.origin + "/api/trpc/workspaces.setActive,tags.create?batch=1", init)).rejects.toThrow("cannot use");
});

it("does not revive an earlier private request after the device policy changes during native readiness", async () => {
  await seedPrivateWorkspaceClient(await privateRecoveryFixture());
  const { openPrivateWorkspaceSyncSession } = await import("./private-workspace-session"), copy = await openPrivateWorkspaceSyncSession("owner", "workspace"), before = await copy.checkpoint();
  let enter!: () => void, resume!: () => void; const waiting = new Promise<void>((resolve) => { enter = resolve; });
  state.ready = async () => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); };
  const pending = client().mutation("tags.create", { name: "Original private policy draft" }); await waiting;
  const { requirePrivateRouting } = await import("./private-routing-requirement"); await requirePrivateRouting({ server: state.origin, userId: "owner" }, () => true, true);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); resume(); await expect(pending).rejects.toThrow("changed");
  expect(await copy.checkpoint()).toEqual(before); expect(fetcher).not.toHaveBeenCalled(); copy.close();
});

it("reads private billing impact locally and keeps historical rates when the project changes for future entries", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); const fetcher = vi.fn(() => { throw new Error("Private billing must stay local"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), project = await api.mutation("projects.create", { name: "Private rate history", hourlyRate: 90 }) as { id: string };
  const input = { description: "Historical private hour", projectId: project.id, start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z", billable: true };
  const old = await api.mutation("entries.create", input) as { id: string }; expect(await api.query("projects.billingImpact", { id: project.id })).toEqual({ entries: 1, invoiced: 0 });
  await expect(api.mutation("projects.update", { id: project.id, hourlyRate: 120, applyToEntries: true })).rejects.toThrow();
  expect(await api.mutation("projects.update", { id: project.id, hourlyRate: 120, applyToEntries: false })).toMatchObject({ hourlyRate: 120, entriesRewritten: null });
  expect(await api.query("entries.get", { id: old.id })).toMatchObject({ hourlyRate: 90 });
  expect(await api.mutation("entries.create", { ...input, description: "New private hour" })).toMatchObject({ hourlyRate: 120 });
  expect(await api.query("projects.billingImpact", { id: project.id })).toEqual({ entries: 2, invoiced: 0 }); expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("reuses an encrypted entry receipt without adding another entry or journal edit", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture()); const fetcher = vi.fn(() => { throw new Error("Private receipt must stay local"); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), intentId = crypto.randomUUID(), input = { description: "One acknowledged private hour", start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z", billable: true, __privateIntentId: intentId };
  const first = await api.mutation("entries.create", input) as { id: string }; expect(first.id).toBe(intentId);
  const { openPrivateWorkspaceSyncSession } = await import("./private-workspace-session"), copy = await openPrivateWorkspaceSyncSession("owner", "workspace");
  try {
    const before = await copy.checkpoint(); expect(await api.mutation("entries.create", { ...input })).toEqual(first); expect(await copy.checkpoint()).toEqual(before);
    await expect(api.mutation("entries.create", { ...input, description: "Changed old operation" })).rejects.toThrow(); expect(await copy.checkpoint()).toEqual(before);
    await api.mutation("entries.remove", { id: first.id }); const deleted = await copy.checkpoint(); expect(await api.mutation("entries.create", input)).toEqual(first); expect(await copy.checkpoint()).toEqual(deleted); await expect(api.query("entries.get", { id: first.id })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
  } finally { copy.close(); }
});
it("keeps private-only entry identities out of both standard HTTP and the direct plaintext write boundary", async () => {
  await confirmStandardDeviceAccess({ server: state.origin, userId: "owner" }, () => true); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const input = { description: "Private intent cannot downgrade", start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z", __privateIntentId: crypto.randomUUID() };
  await expect(client().mutation("entries.create", input)).rejects.toThrow("standard storage"); await expect(offline.submitDurableEntry("entries.create", input, fetcher)).rejects.toThrow("standard queue");
  expect(fetcher).not.toHaveBeenCalled(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});

it("changes member rates using private original IDs and snapshots only future entries without a standard write", async () => {
  await seedPrivateWorkspaceClient(await privateManualEntryFixture());
  const fetcher = vi.fn(async (url: RequestInfo | URL) => { expect(new URL(String(url)).pathname).toBe("/api/trpc/profile.workspaceMemberMetadata"); return Response.json({ result: { data: { workspaceId: "workspace", userId: "owner", members: [{ userId: "owner", memberId: "auth-owner", name: "Account display name", email: "owner@example.test" }] } } }); }); vi.stubGlobal("fetch", fetcher);
  const api = client(), input = { description: "Private member rate hour", billable: true, start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T11:00:00.000Z" };
  expect(await api.query("members.list", {})).toMatchObject([{ memberId: "member", userId: "owner", hourlyRate: 60 }]);
  const original = await api.mutation("entries.create", input) as { id: string; hourlyRate: number }; expect(original.hourlyRate).toBe(60);
  await expect(api.mutation("members.updateRate", { memberId: "auth-owner", hourlyRate: 999 })).rejects.toThrow("could not be confirmed");
  expect(await api.mutation("members.updateRate", { memberId: "member", hourlyRate: 0 })).toMatchObject({ memberId: "member", userId: "owner", hourlyRate: 0 });
  const zero = await api.mutation("entries.create", input) as { id: string; hourlyRate: number }; expect(zero.hourlyRate).toBe(0);
  expect(await api.mutation("members.updateRate", { memberId: "member", hourlyRate: null })).toMatchObject({ hourlyRate: null });
  expect(await api.mutation("entries.create", input)).toMatchObject({ hourlyRate: 80 });
  expect(await api.query("entries.get", { id: original.id })).toMatchObject({ hourlyRate: 60 }); expect(await api.query("entries.get", { id: zero.id })).toMatchObject({ hourlyRate: 0 });
  expect(fetcher).toHaveBeenCalledOnce(); expect(await offline.getOfflineQueue().list()).toEqual([]);
});
