/**
 * The extension in a person's second workspace: its own choice, its caches,
 * its queue and its badge.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ApiClient,
  OfflineStartInput,
  TimeEntry,
  WorkspaceSummary,
  WorkspacePermissions,
} from "@starter/core";
import { saveSession } from "../lib/session";
import { loadWorkspaceChoice } from "../lib/workspace-choice";
import {
  applyEvent,
  discardHeldRow,
  enqueueOffline,
  entriesAreStale,
  flushQueue,
  forgetSession,
  getActiveWorkspaceId,
  getCachedProjects,
  getOfflineQueue,
  listHeldRows,
  pendingSyncCount,
  peekRunning,
  reload,
  resolveWorkspaces,
  setCachedProjects,
  setCachedRunning,
  switchWorkspace,
} from "./runtime";
import { fetchTodaySec } from "./state";

const ME = "user-me";
const COLLEAGUE = "user-colleague";
const A = "ws-a";
const B = "ws-b";

const permissions: WorkspacePermissions = {
  inviteMembers: false,
  inviteAdmins: false,
  changeRoles: false,
  editTimeVisibility: false,
  editMoneyVisibility: false,
  removeMembers: false,
  transferOwnership: false,
  invoices: false,
  viewOthersTime: true,
  viewOthersMoney: false,
};

const workspace = (id: string, name: string, isDefault: boolean): WorkspaceSummary => ({
  id,
  name,
  role: "member",
  memberCount: 2,
  isDefault,
  permissions,
});

const entry = (overrides: Partial<TimeEntry>): TimeEntry => ({
  id: "e-1",
  workspaceId: A,
  authorId: ME,
  description: "",
  projectId: null,
  taskId: null,
  billable: false,
  start: "2026-09-14T09:00:00.000Z",
  end: null,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: "web",
  timeZone: null,
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-14T09:00:00.000Z",
  updatedAt: "2026-09-14T09:00:00.000Z",
  ...overrides,
});

type Call = { path: string; input: Record<string, unknown> | undefined };

/** A tiny tRPC server: the membership list, and every mutation accepted. */
const server = {
  memberships: [workspace(A, "Acme", true), workspace(B, "Beta", false)],
  listFails: false,
  refuse: null as null | { path: string; status: number; code: string; message?: string },
  calls: [] as Call[],
};

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/api\/trpc\//, "");
  const raw =
    init?.method === "POST"
      ? String(init.body)
      : parsed.searchParams.get("input");
  const input = raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  server.calls.push({ path, input });

  if (path === "workspaces.list") {
    if (server.listFails) throw new TypeError("fetch failed");
    return reply(200, { result: { data: server.memberships } });
  }
  if (server.refuse?.path === path) {
    return reply(server.refuse.status, {
      error: {
        message: server.refuse.message ?? "refused",
        data: { code: server.refuse.code, httpStatus: server.refuse.status },
      },
    });
  }
  if (path === "entries.start") {
    return reply(200, { result: { data: { ...entry({}), replaced: null } } });
  }
  return reply(200, { result: { data: null } });
};

const startInput = (description: string): OfflineStartInput => ({
  description,
  projectId: null,
  taskId: null,
  tagIds: [],
  billable: false,
  start: "2026-09-14T09:00:00.000Z",
  source: "extension",
  timeZone: "UTC",
  originId: "origin-test",
});

beforeEach(async () => {
  server.memberships = [workspace(A, "Acme", true), workspace(B, "Beta", false)];
  server.listFails = false;
  server.refuse = null;
  server.calls = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  await saveSession({ token: "token-1", userId: ME, email: "me@example.com" });
  await reload();
  // The queue object outlives the per-test fake `chrome`, so empty it here.
  await getOfflineQueue().clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── the choice ───────────────────────────────────────────────────────

test("resolves the default, and addresses every request to the chosen workspace", async () => {
  await resolveWorkspaces();
  expect(getActiveWorkspaceId()).toBe(A);

  expect(await switchWorkspace(B)).toBe(true);
  expect(getActiveWorkspaceId()).toBe(B);
  expect((await loadWorkspaceChoice()).workspaceId).toBe(B);

  // A rebuilt worker (an eviction) comes back pointed at the same place.
  await reload();
  expect(getActiveWorkspaceId()).toBe(B);
});

test("a switch drops the old workspace's caches and never tells the server's session", async () => {
  await resolveWorkspaces();
  setCachedProjects([{ id: "p-a" } as never]);

  await switchWorkspace(B);

  expect(getCachedProjects()).toBeNull();
  // `workspaces.setActive` moves the SESSION, which the web app may share.
  expect(server.calls.some((call) => call.path === "workspaces.setActive")).toBe(false);
});

test("a workspace the account is not in cannot be chosen", async () => {
  expect(await switchWorkspace("ws-elsewhere")).toBe(false);
  expect(getActiveWorkspaceId()).toBe(A);
});

test("a stored choice that is no longer a membership falls back to the default", async () => {
  await resolveWorkspaces();
  await switchWorkspace(B);
  setCachedProjects([{ id: "p-b" } as never]);

  server.memberships = [workspace(A, "Acme", true)];
  await reload();
  await resolveWorkspaces();

  expect(getActiveWorkspaceId()).toBe(A);
  expect(getCachedProjects()).toBeNull();
});

test("sign-out forgets the choice", async () => {
  await resolveWorkspaces();
  await switchWorkspace(B);
  await forgetSession();
  expect((await loadWorkspaceChoice()).workspaceId).toBeNull();
});

// ── the socket ───────────────────────────────────────────────────────

test("a colleague's timer never becomes the badge, and a colleague's stop never clears it", async () => {
  await resolveWorkspaces();
  const mine = entry({ id: "mine" });
  setCachedRunning(mine);

  applyEvent({ kind: "timer.started", entry: entry({ id: "theirs", authorId: COLLEAGUE }) }, A);
  expect(peekRunning()?.id).toBe("mine");

  applyEvent(
    { kind: "timer.stopped", entry: entry({ id: "theirs", authorId: COLLEAGUE, end: "2026-09-14T10:00:00.000Z" }) },
    A,
  );
  expect(peekRunning()?.id).toBe("mine");

  applyEvent(
    { kind: "entry.upserted", entry: entry({ id: "theirs-2", authorId: COLLEAGUE }) },
    A,
  );
  expect(peekRunning()?.id).toBe("mine");

  applyEvent(
    { kind: "timer.stopped", entry: entry({ id: "mine", end: "2026-09-14T10:00:00.000Z" }) },
    A,
  );
  expect(peekRunning()).toBeNull();
});

test("my own start in another workspace moves the badge, and touches nothing else", async () => {
  await resolveWorkspaces();
  expect(getActiveWorkspaceId()).toBe(A);

  applyEvent({ kind: "timer.started", entry: entry({ id: "in-b", workspaceId: B }) }, B);

  expect(peekRunning()?.id).toBe("in-b");
  expect(entriesAreStale()).toBe(false);
});

test("another workspace's catalog change leaves this workspace's catalog alone", async () => {
  await resolveWorkspaces();
  setCachedProjects([{ id: "p-a" } as never]);
  applyEvent({ kind: "catalog.changed", scope: "project" }, B);
  expect(getCachedProjects()).not.toBeNull();
  applyEvent({ kind: "catalog.changed", scope: "project" }, A);
  expect(getCachedProjects()).toBeNull();
});

test("a sync event kind or scope from a newer server rebuilds the snapshot instead of being ignored", async () => {
  await resolveWorkspaces();
  setCachedProjects([{ id: "p-a" } as never]);
  setCachedRunning(entry({ id: "mine" }));
  // Neither is in this build's SyncEvent union — exactly what a newer server sends.
  applyEvent({ kind: "timer.paused" } as never, A);
  expect(getCachedProjects()).toBeNull();
  expect(peekRunning()).toBeNull();

  setCachedProjects([{ id: "p-a" } as never]);
  applyEvent({ kind: "catalog.changed", scope: "rate" } as never, A);
  expect(getCachedProjects()).toBeNull();
});

test("an unknown kind from another workspace re-reads the timer and nothing else", async () => {
  await resolveWorkspaces();
  setCachedProjects([{ id: "p-a" } as never]);
  setCachedRunning(entry({ id: "mine" }));
  applyEvent({ kind: "timer.paused" } as never, B);
  expect(peekRunning()).toBeNull();
  expect(getCachedProjects()).not.toBeNull();
});

test("without knowing who is signed in, no event's timer is believed", async () => {
  await saveSession({ token: "token-2", userId: null, email: null });
  await reload();
  setCachedRunning(entry({ id: "mine" }));

  applyEvent({ kind: "timer.started", entry: entry({ id: "someone", authorId: COLLEAGUE }) });

  // Dropped rather than replaced: the next read asks `entries.current`.
  expect(peekRunning()).toBeNull();
});

// ── the day total ────────────────────────────────────────────────────

test("today counts only the signed-in person's time", async () => {
  const now = new Date(2026, 8, 14, 18, 0, 0).getTime();
  const at = (hour: number): string => new Date(2026, 8, 14, hour, 0, 0).toISOString();
  const api: ApiClient = {
    query: (async () => ({
      entries: [
        entry({ id: "1", authorId: ME, start: at(9), end: at(10) }),
        entry({ id: "2", authorId: COLLEAGUE, start: at(9), end: at(17) }),
      ],
    })) as ApiClient["query"],
    mutate: (async () => null) as ApiClient["mutate"],
  };

  expect(await fetchTodaySec(api, ME, now)).toBe(3600);
  // A total that cannot tell whose time it is adds none.
  expect(await fetchTodaySec(api, null, now)).toBe(0);
});

// ── the queue ────────────────────────────────────────────────────────

test("a start queued in A replays into A after a switch to B", async () => {
  await resolveWorkspaces();
  await enqueueOffline("entries.start", startInput("queued in A"), "tmp_1");

  await switchWorkspace(B);
  server.calls = [];
  expect(await flushQueue()).toBe(0);

  const start = server.calls.find((call) => call.path === "entries.start");
  expect(start?.input?.workspaceId).toBe(A);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("rows for a workspace the person was removed from are held, named, and never sent", async () => {
  await resolveWorkspaces();
  await switchWorkspace(B);
  await enqueueOffline("entries.start", startInput("Design review"), "tmp_1");

  server.memberships = [workspace(A, "Acme", true)];
  await reload();
  server.calls = [];

  // Not blocking: a new mutation must not queue behind a row that never drains.
  expect(await flushQueue()).toBe(0);
  expect(server.calls.some((call) => call.path === "entries.start")).toBe(false);
  expect(await getOfflineQueue().size()).toBe(1);
  expect(await pendingSyncCount()).toBe(0);

  const held = await listHeldRows();
  expect(held).toHaveLength(1);
  expect(held[0]?.workspaceName).toBe("Beta");
  expect(held[0]?.description).toBe("Design review");

  // The one way out is deliberate.
  expect(await discardHeldRow(held[0]?.queueId ?? "")).toBe(true);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("a row that is not held cannot be discarded through the held path", async () => {
  await resolveWorkspaces();
  server.listFails = true;
  await enqueueOffline("entries.start", startInput("still sendable"), "tmp_1");
  const [row] = await getOfflineQueue().list();
  expect(await discardHeldRow(row?.id ?? "")).toBe(false);
  expect(await getOfflineQueue().size()).toBe(1);
});

test("with no membership list nothing is flushed", async () => {
  await enqueueOffline("entries.start", startInput("waiting"), "tmp_1");
  server.listFails = true;
  await reload();

  expect(await flushQueue()).toBe(1);
  expect(server.calls.some((call) => call.path === "entries.start")).toBe(false);
});

test("a NOT_FOUND from a workspace just left keeps the row instead of dropping it", async () => {
  await resolveWorkspaces();
  await switchWorkspace(B);
  await enqueueOffline("entries.start", startInput("Design review"), "tmp_1");

  // The worker still believes it is in B; the server has already removed it.
  server.refuse = { path: "entries.start", status: 404, code: "NOT_FOUND" };
  server.memberships = [workspace(A, "Acme", true)];

  await flushQueue();
  expect(await getOfflineQueue().size()).toBe(1);
  expect(await listHeldRows()).toHaveLength(1);
});

test("a FORBIDDEN refusal drops that one row and lets the rest through", async () => {
  await resolveWorkspaces();
  await enqueueOffline("entries.update", { id: "e-1", description: "x" } as never);
  await enqueueOffline("entries.start", startInput("next"), "tmp_2");
  server.refuse = { path: "entries.update", status: 403, code: "FORBIDDEN" };

  expect(await flushQueue()).toBe(0);
  expect(server.calls.some((call) => call.path === "entries.start")).toBe(true);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("legacy unstamped rows are adopted by the resolved workspace", async () => {
  await getOfflineQueue().enqueue("entries.start", { input: startInput("legacy"), tempId: "tmp_1" });
  await resolveWorkspaces();
  const [row] = await getOfflineQueue().list();
  expect(row?.workspaceId).toBe(A);
});

test("a worker that never resolved a workspace resolves one before its first write", async () => {
  const { startTimer } = await import("./timer");
  server.calls = [];

  await startTimer("first", null);

  const start = server.calls.find((call) => call.path === "entries.start");
  // Never left for the server to fill from the session, which the web app moves.
  expect(start?.input?.workspaceId).toBe(A);
});

// ── held rows ────────────────────────────────────────────────────────

test("a server without the procedure holds the row and its chain, and the rest still goes", async () => {
  await resolveWorkspaces();
  await enqueueOffline("entries.discard", { originId: "o" }, "tmp_1");
  await enqueueOffline("entries.stop", { end: "2026-09-14T10:00:00.000Z", originId: "o" }, "tmp_1");
  await enqueueOffline("entries.start", startInput("after"), "tmp_2");
  server.refuse = {
    path: "entries.discard",
    status: 404,
    code: "NOT_FOUND",
    message: 'No procedure found on path "entries.discard"',
  };
  server.calls = [];

  // Not blocking: a new mutation must not queue behind rows that may never drain.
  expect(await flushQueue()).toBe(0);
  expect(server.calls.map((call) => call.path).filter((path) => path.startsWith("entries."))).toEqual([
    "entries.discard",
    "entries.start",
  ]);
  expect(await getOfflineQueue().size()).toBe(2);
  expect(await pendingSyncCount()).toBe(0);
  const held = await listHeldRows();
  expect(held.map((row) => [row.op, row.hold])).toEqual([
    ["entries.discard", "unknown-procedure"],
    ["entries.stop", "unknown-procedure"],
  ]);

  // Within the hour the server is not asked again.
  server.calls = [];
  await flushQueue();
  expect(server.calls.some((call) => call.path === "entries.discard")).toBe(false);

  // The way out is deliberate, one named row at a time.
  expect(await discardHeldRow(held[1]?.queueId ?? "")).toBe(true);
  expect(await getOfflineQueue().size()).toBe(1);
});

test("a row this build cannot read is held, never sent and never dropped", async () => {
  await resolveWorkspaces();
  await getOfflineQueue().enqueue("entries.future", { input: {} }, undefined, undefined, A);
  server.calls = [];

  expect(await flushQueue()).toBe(0);
  expect(server.calls.some((call) => call.path === "entries.future")).toBe(false);
  expect(await getOfflineQueue().size()).toBe(1);
  const [held] = await listHeldRows();
  expect(held?.op).toBeNull();
  expect(held?.hold).toBe("unknown-op");
});

test("an application NOT_FOUND in a workspace the person is still in drops the row", async () => {
  await resolveWorkspaces();
  await enqueueOffline("entries.stop", { end: "2026-09-14T10:00:00.000Z", originId: "o" });
  server.refuse = { path: "entries.stop", status: 404, code: "NOT_FOUND", message: "No running entry" };

  expect(await flushQueue()).toBe(0);
  expect(await getOfflineQueue().size()).toBe(0);
  expect(await listHeldRows()).toHaveLength(0);
});

// ── whose rows ───────────────────────────────────────────────────────

test("every queued row names the account that queued it", async () => {
  await resolveWorkspaces();
  await enqueueOffline("entries.start", startInput("mine"), "tmp_1");
  expect((await getOfflineQueue().list())[0]?.owner).toBe(ME);
});

test("another account's rows are held for it: never sent, not pending, discardable", async () => {
  await resolveWorkspaces();
  await getOfflineQueue().enqueue(
    "entries.start",
    { input: startInput("somebody else's"), tempId: "tmp_1" },
    COLLEAGUE,
    "http://127.0.0.1:9",
    A,
  );
  server.calls = [];

  expect(await flushQueue()).toBe(0);
  expect(server.calls.some((call) => call.path === "entries.start")).toBe(false);
  expect(await pendingSyncCount()).toBe(0);
  const [held] = await listHeldRows();
  expect(held?.hold).toBe("other-account");
  expect(await discardHeldRow(held?.queueId ?? "")).toBe(true);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("rows from before the owner stamp are claimed by the account that flushes them", async () => {
  await resolveWorkspaces();
  await getOfflineQueue().enqueue("entries.start", { input: startInput("legacy"), tempId: "tmp_1" });
  server.calls = [];

  expect(await flushQueue()).toBe(0);
  expect(server.calls.some((call) => call.path === "entries.start")).toBe(true);
});
