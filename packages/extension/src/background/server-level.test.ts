/**
 * The worker against a server older than this build: queued rows are held,
 * never sent into a server that cannot take them and never dropped, and the
 * level cache is kept current from the moments the worker learns something.
 *
 * Every test points the worker at its own origin. The level cache is module
 * state, like the queue, and a level one test recorded must not decide another.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { API_LEVEL, type OfflineStartInput, type WorkspaceSummary } from "@starter/core";
import { API_URL_STORAGE_KEY } from "../lib/config";
import { saveSession } from "../lib/session";
import { searchDescriptions } from "./descriptions";
import {
  enqueueOffline,
  flushQueue,
  getCachedDescriptions,
  getOfflineQueue,
  getServerLevels,
  listHeldRows,
  pendingSyncCount,
  reload,
  resolveWorkspaces,
} from "./runtime";
import { resolveCompatibility } from "./state";

const ME = "user-me";
const A = "ws-a";

const membership: WorkspaceSummary = {
  id: A,
  name: "Acme",
  role: "owner",
  memberCount: 1,
  isDefault: true,
  permissions: {
    inviteMembers: true,
    inviteAdmins: true,
    changeRoles: true,
    editTimeVisibility: true,
    editMoneyVisibility: true,
    removeMembers: true,
    transferOwnership: true,
    invoices: true,
    viewOthersTime: true,
    viewOthersMoney: true,
  },
};

/** The server: its health answer, and one path it refuses. */
const server = {
  /** null: `/api/health` cannot be reached. */
  apiLevel: null as number | null,
  refuse: null as null | { path: string; status: number; code: string; message: string },
  calls: [] as string[],
  /** Refuse every entry procedure as `CLIENT_TOO_OLD`. */
  versionRefusal: false,
};

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const fakeFetch = async (url: string): Promise<Response> => {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/health") {
    server.calls.push("health");
    if (server.apiLevel === null) throw new TypeError("fetch failed");
    return reply(200, {
      status: "ok",
      service: "trackyourtime",
      db: true,
      webUrl: "https://web.example.com",
      release: "0.1.0",
      apiLevel: server.apiLevel,
    });
  }
  const path = parsed.pathname.replace(/^\/api\/trpc\//, "");
  server.calls.push(path);
  if (path === "workspaces.list") return reply(200, { result: { data: [membership] } });
  if (server.versionRefusal && path.startsWith("entries.")) {
    return reply(412, {
      error: {
        message: "Update the app",
        data: { code: "PRECONDITION_FAILED", httpStatus: 412, versionRefusal: "CLIENT_TOO_OLD" },
      },
    });
  }
  if (server.refuse?.path === path) {
    return reply(server.refuse.status, {
      error: {
        message: server.refuse.message,
        data: { code: server.refuse.code, httpStatus: server.refuse.status },
      },
    });
  }
  if (path === "entries.descriptions") return reply(200, { result: { data: [] } });
  return reply(200, { result: { data: { id: "e-1" } } });
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

let port = 41000;
let origin = "";

/** A fresh origin, so no level from an earlier test applies. */
const pointAtNewServer = async (): Promise<void> => {
  port += 1;
  origin = `http://127.0.0.1:${port}`;
  await chrome.storage.local.set({ [API_URL_STORAGE_KEY]: origin });
  await reload();
  // Let the build's own level refresh settle before the test sets the scene.
  await getServerLevels().refresh(origin);
};

const entryCalls = (): string[] => server.calls.filter((call) => call.startsWith("entries."));

beforeEach(async () => {
  server.apiLevel = null;
  server.refuse = null;
  server.versionRefusal = false;
  server.calls = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  await saveSession({ token: "token-1", userId: ME, email: "me@example.com" });
  await pointAtNewServer();
  await getOfflineQueue().clear();
  await resolveWorkspaces();
  server.calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const recordLevel = (apiLevel: number): void =>
  getServerLevels().record({ origin, apiLevel, minClientApiLevel: null, release: "0.1.0" });

test("a row queued by a higher level is held before it is sent, and released by an update", async () => {
  recordLevel(API_LEVEL - 1);
  await enqueueOffline("entries.start", startInput("offline work"), "tmp_1");
  const [queued] = await getOfflineQueue().list();
  expect(queued?.apiLevel).toBe(API_LEVEL);

  expect(await flushQueue()).toBe(0);
  expect(entryCalls()).toEqual([]);
  expect(await getOfflineQueue().size()).toBe(1);
  expect(await pendingSyncCount()).toBe(0);
  expect((await listHeldRows()).map((row) => row.hold)).toEqual(["server-too-old"]);

  // Still too old: not asked again, whatever the clock says.
  expect(await flushQueue()).toBe(0);
  expect(entryCalls()).toEqual([]);

  // The operator upgrades. The hold ends on the level alone.
  recordLevel(API_LEVEL);
  expect(await listHeldRows()).toEqual([]);
  expect(await pendingSyncCount()).toBe(1);
  expect(await flushQueue()).toBe(0);
  expect(entryCalls()).toEqual(["entries.start"]);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("a 400 on a row of a higher level than the server is held, not dropped", async () => {
  // Nothing known yet — a cold offline start — so the row is sent.
  expect(getServerLevels().apiLevel(origin)).toBeNull();
  await enqueueOffline("entries.start", startInput("offline work"), "tmp_1");
  server.apiLevel = API_LEVEL - 1;
  server.refuse = {
    path: "entries.start",
    status: 400,
    code: "BAD_REQUEST",
    message: "Unrecognized key: tagIds",
  };

  expect(await flushQueue()).toBe(0);
  expect(entryCalls()).toEqual(["entries.start"]);
  expect(await getOfflineQueue().size()).toBe(1);
  expect((await listHeldRows()).map((row) => row.hold)).toEqual(["server-too-old"]);
  expect(getServerLevels().apiLevel(origin)).toBe(API_LEVEL - 1);
});

test("a 400 from a server that is new enough still drops the row", async () => {
  recordLevel(API_LEVEL);
  server.apiLevel = API_LEVEL;
  await enqueueOffline("entries.start", startInput("bad"), "tmp_1");
  server.refuse = { path: "entries.start", status: 400, code: "BAD_REQUEST", message: "invalid" };

  expect(await flushQueue()).toBe(0);
  expect(await getOfflineQueue().size()).toBe(0);
});

test("a server without a procedure makes the flush ask for its level", async () => {
  expect(getServerLevels().apiLevel(origin)).toBeNull();
  await enqueueOffline("entries.discard", { originId: "o" }, "tmp_1");
  server.apiLevel = 0;
  server.refuse = {
    path: "entries.discard",
    status: 404,
    code: "NOT_FOUND",
    message: 'No procedure found on path "entries.discard"',
  };

  await flushQueue();

  expect((await listHeldRows()).map((row) => row.hold)).toEqual(["unknown-procedure"]);
  expect(server.calls).toContain("health");
  expect(getServerLevels().apiLevel(origin)).toBe(0);
  expect(resolveCompatibility(origin).refusal).toBe("SERVER_TOO_OLD");
});

test("a CLIENT_TOO_OLD refusal from any request is noted for the banner", async () => {
  recordLevel(API_LEVEL);
  await enqueueOffline("entries.start", startInput("x"), "tmp_1");
  server.versionRefusal = true;
  await flushQueue().catch(() => undefined);
  expect(resolveCompatibility(origin).refusal).toBe("CLIENT_TOO_OLD");
  // A refusal is never a reason to delete queued time.
  expect(await getOfflineQueue().size()).toBe(1);
});

test("the description autocomplete is not asked of a server without it", async () => {
  recordLevel(0);
  await searchDescriptions("meet");
  expect(entryCalls()).toEqual([]);
  expect(getCachedDescriptions()).toMatchObject({ query: "meet", rows: [] });

  recordLevel(API_LEVEL);
  await searchDescriptions("meeting");
  expect(entryCalls()).toEqual(["entries.descriptions"]);
});
