// @vitest-environment jsdom
/**
 * The flush, as the shell runs it, in a person with several workspaces.
 *
 * Two rules that live in the hook rather than in `lib/offline.ts`:
 *
 *  - **No membership answer, no flush.** The last known list can be a day old;
 *    a row for a workspace the person was removed from since would be sent,
 *    refused as NOT_FOUND and dropped. So the flush asks first and does
 *    nothing when it cannot.
 *  - **FORBIDDEN refuses one row, not the session.** A role change is a valid
 *    session refused one write. It used to be classified as an auth error,
 *    which stopped the flush at that row, held every row behind it, and showed
 *    "Signed out — sign in to sync" to somebody who was signed in.
 *
 * `@/lib/trpc` is faked: the replay mutations record their input, and
 * `workspaces.list.fetch` answers (or fails) as each test says. The queue, the
 * replay runner and the active-workspace store are the real ones.
 */
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@starter/core";

vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => true,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/use-sync", () => ({ useSyncStatus: () => "closed" }));

const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

type Sent = { op: string; input: Record<string, unknown> };
const sent: Sent[] = [];
/** Per-op failure to throw instead of answering, consumed once. */
const failNext = new Map<string, unknown>();
let listAnswer: () => Promise<WorkspaceSummary[]> = async () => [];

const mutation = (op: string) => ({
  useMutation: () => ({
    mutateAsync: async (input: Record<string, unknown>) => {
      const failure = failNext.get(`${op}:${String(input.description ?? "")}`);
      if (failure !== undefined) throw failure;
      sent.push({ op, input });
      return { id: `real-${sent.length}`, replaced: null };
    },
  }),
});

vi.mock("@/lib/trpc", () => {
  const utils = {
    entries: { invalidate: async () => undefined },
    reports: { invalidate: async () => undefined },
    workspaces: { list: { fetch: () => listAnswer() } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      workspaces: {
        list: {
          useQuery: () => ({ data: undefined, refetch: async () => undefined }),
        },
      },
      entries: {
        start: mutation("entries.start"),
        stop: mutation("entries.stop"),
        create: mutation("entries.create"),
        update: mutation("entries.update"),
        remove: mutation("entries.remove"),
        discard: mutation("entries.discard"),
      },
    },
  };
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useOfflineQueue } = await import("./use-offline-queue");
const offline = await import("@/lib/offline");
const activeWorkspace = await import("@/lib/active-workspace");

const workspace = (id: string, name: string, isDefault = false): WorkspaceSummary => ({
  id,
  name,
  role: "member",
  memberCount: 2,
  isDefault,
  permissions: {
    inviteMembers: false,
    inviteAdmins: false,
    changeRoles: false,
    editTimeVisibility: false,
    editMoneyVisibility: false,
    removeMembers: false,
    transferOwnership: false,
    invoices: false,
    viewOthersTime: false,
    viewOthersMoney: false,
  },
});
const A = workspace("ws-a", "Acme", true);
const B = workspace("ws-b", "Beta");

const start = (description: string) => ({
  description,
  projectId: null,
  taskId: null,
  billable: false,
  start: new Date().toISOString(),
  source: "web" as const,
  timeZone: "UTC",
  originId: "tab",
});

const renderQueue = () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOfflineQueue(), { wrapper });
};

beforeEach(async () => {
  window.localStorage.clear();
  sent.length = 0;
  failNext.clear();
  toastError.mockClear();
  toastWarning.mockClear();
  offline.__resetOfflineQueueForTests();
  offline.__resetOfflineQueueOwnerForTests();
  activeWorkspace.__resetActiveWorkspaceForTests();
  await offline.setOfflineQueueOwner("user-1");
  await activeWorkspace.applyWorkspaceList([A, B], "user-1");
});

afterEach(cleanup);

describe("useOfflineQueue in several workspaces", () => {
  it("does not flush when the membership list cannot be loaded", async () => {
    await offline.enqueueOffline("entries.start", start("queued"), "temp-1", A.id);
    listAnswer = async () => {
      throw new Error("list failed");
    };
    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });
    expect(sent).toEqual([]);
    expect(await offline.getOfflineQueue().size()).toBe(1);
  });

  it("replays into the stamped workspace, holding a removed workspace's rows", async () => {
    await offline.enqueueOffline("entries.start", start("in A"), "temp-1", A.id);
    await offline.enqueueOffline("entries.start", start("in B"), "temp-2", B.id);
    // Switched to B, then removed from A before reconnecting.
    await activeWorkspace.switchWorkspace(B.id, { queryClient: new QueryClient() });
    listAnswer = async () => [B];

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(sent.map((call) => [call.input.description, call.input.workspaceId])).toEqual([
      ["in B", B.id],
    ]);
    const held = await offline.getOfflineQueue().list();
    expect(held.map((row) => row.workspaceId)).toEqual([A.id]);
    expect(result.current.authBlocked).toBe(false);
  });

  it("a FORBIDDEN on one row drops that row and keeps flushing, with no sign-in copy", async () => {
    await offline.enqueueOffline("entries.start", start("refused"), "temp-1", A.id);
    await offline.enqueueOffline("entries.start", start("fine"), "temp-2", A.id);
    failNext.set(
      "entries.start:refused",
      Object.assign(new Error("admin-required"), { data: { code: "FORBIDDEN" } }),
    );
    listAnswer = async () => [A, B];

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(sent.map((call) => call.input.description)).toEqual(["fine"]);
    expect(await offline.getOfflineQueue().size()).toBe(0);
    expect(result.current.authBlocked).toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      "One offline change could not be saved",
      expect.anything(),
    );
  });

  it("an UNAUTHORIZED still stops the flush and keeps every row", async () => {
    await offline.enqueueOffline("entries.start", start("expired"), "temp-1", A.id);
    await offline.enqueueOffline("entries.start", start("behind"), "temp-2", A.id);
    failNext.set(
      "entries.start:expired",
      Object.assign(new Error("no"), { data: { code: "UNAUTHORIZED" } }),
    );
    listAnswer = async () => [A, B];

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(sent).toEqual([]);
    expect(await offline.getOfflineQueue().size()).toBe(2);
    expect(result.current.authBlocked).toBe(true);
  });
});

describe("a transient server error mid-flush", () => {
  const cases = [
    ["a 500", { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 }],
    ["a 429", { code: "TOO_MANY_REQUESTS", httpStatus: 429 }],
    ["a 503", { code: "SERVICE_UNAVAILABLE", httpStatus: 503 }],
  ] as const;

  for (const [label, data] of cases) {
    it(`${label} stops the flush and keeps that row and every row behind it`, async () => {
      await offline.enqueueOffline("entries.start", start("first"), "temp-1", A.id);
      await offline.enqueueOffline("entries.start", start("hit"), "temp-2", A.id);
      await offline.enqueueOffline("entries.start", start("behind"), "temp-3", A.id);
      failNext.set("entries.start:hit", Object.assign(new Error(data.code), { data }));
      listAnswer = async () => [A, B];

      const { result } = renderQueue();
      await act(async () => {
        await result.current.flush();
      });

      expect(sent.map((call) => call.input.description)).toEqual(["first"]);
      const kept = await offline.getOfflineQueue().list();
      expect(kept).toHaveLength(2);
      expect(result.current.authBlocked).toBe(false);
      expect(toastError).not.toHaveBeenCalled();

      // The next flush, once the server is back, sends both in order.
      failNext.delete("entries.start:hit");
      await act(async () => {
        await result.current.flush();
      });
      expect(sent.map((call) => call.input.description)).toEqual(["first", "hit", "behind"]);
      expect(await offline.getOfflineQueue().size()).toBe(0);
    });
  }
});

describe("a NOT_FOUND mid-flush", () => {
  const notFound = () =>
    Object.assign(new Error("not found"), { data: { code: "NOT_FOUND" } });

  it("keeps the row when the workspace was lost after the flush began", async () => {
    await offline.enqueueOffline("entries.start", start("first"), "temp-1", A.id);
    await offline.enqueueOffline("entries.start", start("removed mid-flush"), "temp-2", A.id);
    // The first answer still lists A; the person is removed from A while the
    // flush runs, so the second row is refused and the re-ask no longer has A.
    const answers = [[A, B], [B]];
    listAnswer = async () => answers.shift() ?? [B];
    failNext.set("entries.start:removed mid-flush", notFound());

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(sent.map((call) => call.input.description)).toEqual(["first"]);
    const kept = await offline.getOfflineQueue().list();
    expect(kept.map((row) => row.workspaceId)).toEqual([A.id]);
    expect(toastError).not.toHaveBeenCalledWith(
      "One offline change could not be saved",
      expect.anything(),
    );
    // And it is held from now on, not retried into anything.
    expect(offline.getForeignCount()).toBe(1);
  });

  it("keeps the row when the re-ask itself fails", async () => {
    await offline.enqueueOffline("entries.start", start("gone?"), "temp-1", A.id);
    let calls = 0;
    listAnswer = async () => {
      calls += 1;
      if (calls > 1) throw new Error("offline again");
      return [A, B];
    };
    failNext.set("entries.start:gone?", notFound());

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(await offline.getOfflineQueue().size()).toBe(1);
    expect(toastError).not.toHaveBeenCalledWith(
      "One offline change could not be saved",
      expect.anything(),
    );
  });

  it("still drops, out loud, a NOT_FOUND in a workspace the person is still in", async () => {
    await offline.enqueueOffline("entries.start", start("entry gone"), "temp-1", A.id);
    listAnswer = async () => [A, B];
    failNext.set("entries.start:entry gone", notFound());

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(await offline.getOfflineQueue().size()).toBe(0);
    expect(toastError).toHaveBeenCalledWith(
      "One offline change could not be saved",
      expect.anything(),
    );
  });
});

describe("a server without the procedure", () => {
  const unknownPath = (path: string) =>
    Object.assign(new Error(`No procedure found on path "${path}"`), {
      data: { code: "NOT_FOUND", httpStatus: 404 },
    });

  it("holds the row and its chain, keeps flushing, and asks again only later", async () => {
    await offline.enqueueOffline("entries.start", start("new timer"), "temp-1", A.id);
    await offline.enqueueOffline("entries.discard", { originId: "tab" }, "temp-1", A.id);
    await offline.enqueueOffline("entries.stop", { end: new Date().toISOString(), originId: "tab" }, "temp-1", A.id);
    await offline.enqueueOffline("entries.start", start("after"), "temp-2", A.id);
    listAnswer = async () => [A, B];
    failNext.set("entries.discard:", unknownPath("entries.discard"));

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    // The start went; the discard is held and the stop that shares its temp
    // id waits with it; the unrelated start behind them still went.
    expect(sent.map((call) => [call.op, call.input.description])).toEqual([
      ["entries.start", "new timer"],
      ["entries.start", "after"],
    ]);
    const kept = await offline.getOfflineQueue().list();
    expect(kept.map((row) => [row.op, row.hold?.reason ?? null])).toEqual([
      ["entries.discard", "unknown-procedure"],
      ["entries.stop", null],
    ]);
    expect(offline.getHeldCount()).toBe(2);
    expect(offline.getPendingCount()).toBe(0);
    expect(result.current.authBlocked).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith(
      "One offline change is waiting",
      expect.anything(),
    );

    // Within the hour, the next flush does not ask the server again.
    const before = sent.length;
    await act(async () => {
      await result.current.flush();
    });
    expect(sent.length).toBe(before);
    expect(await offline.getOfflineQueue().size()).toBe(2);

    // The listing says why, for both rows.
    const listed = await offline.listForeignQueued();
    expect(listed.map((row) => row.hold)).toEqual(["unknown-procedure", "unknown-procedure"]);
  });

  it("sends a held row, and its chain, once the hold is due and the server has it", async () => {
    await offline.enqueueOffline("entries.discard", { originId: "tab" }, "temp-1", A.id);
    await offline.enqueueOffline("entries.stop", { end: new Date().toISOString(), originId: "tab" }, "temp-1", A.id);
    listAnswer = async () => [A, B];
    failNext.set("entries.discard:", unknownPath("entries.discard"));

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });
    expect(sent).toEqual([]);

    // An hour on, the server was upgraded.
    failNext.clear();
    const later = Date.now() + 61 * 60 * 1000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await act(async () => {
        await result.current.flush();
      });
    } finally {
      now.mockRestore();
    }
    expect(sent.map((call) => call.op)).toEqual(["entries.discard", "entries.stop"]);
    expect(await offline.getOfflineQueue().size()).toBe(0);
  });

  it("an application NOT_FOUND is still a refusal on the merits", async () => {
    await offline.enqueueOffline("entries.stop", { end: new Date().toISOString(), originId: "tab" }, undefined, A.id);
    listAnswer = async () => [A, B];
    failNext.set(
      "entries.stop:",
      Object.assign(new Error("No running entry"), { data: { code: "NOT_FOUND", httpStatus: 404 } }),
    );

    const { result } = renderQueue();
    await act(async () => {
      await result.current.flush();
    });

    expect(await offline.getOfflineQueue().size()).toBe(0);
    expect(offline.getHeldCount()).toBe(0);
    expect(toastError).toHaveBeenCalledWith(
      "One offline change could not be saved",
      expect.anything(),
    );
  });
});

describe("a server older than the build that queued the row", () => {
  const levels = async () => {
    const serverLevel = await import("@/lib/server-level");
    const { createServerLevelCache, API_LEVEL } = await import("@starter/core");
    const { getAbsoluteApiOrigin } = await import("@/lib/api-origin");
    const cache = createServerLevelCache({
      check: async () => ({ ok: false, problem: "unreachable", message: "offline" }),
    });
    serverLevel.__setServerLevelCacheForTests(cache);
    const at = (apiLevel: number): void =>
      cache.record({ origin: getAbsoluteApiOrigin(), apiLevel, minClientApiLevel: null, release: null });
    return { at, API_LEVEL, reset: () => serverLevel.__setServerLevelCacheForTests(null) };
  };

  it("holds the row without sending it, and sends it once the server reports enough", async () => {
    const { at, API_LEVEL, reset } = await levels();
    try {
      await offline.enqueueOffline("entries.start", start("needs a newer server"), "temp-1", A.id);
      listAnswer = async () => [A, B];
      at(API_LEVEL - 1);

      const { result } = renderQueue();
      await act(async () => {
        await result.current.flush();
      });
      expect(sent).toEqual([]);
      const kept = await offline.getOfflineQueue().list();
      expect(kept.map((row) => [row.apiLevel, row.hold?.reason ?? null])).toEqual([
        [API_LEVEL, "server-too-old"],
      ]);
      expect(offline.getHeldCount()).toBe(1);
      expect(toastError).not.toHaveBeenCalled();

      // The server was updated: released at once, not an hour later.
      at(API_LEVEL);
      await act(async () => {
        await result.current.flush();
      });
      expect(sent.map((call) => call.input.description)).toEqual(["needs a newer server"]);
      expect(await offline.getOfflineQueue().size()).toBe(0);
    } finally {
      reset();
    }
  });

  it("holds, rather than drops, a 400 on a row of a higher level than the server", async () => {
    const { at, API_LEVEL, reset } = await levels();
    try {
      await offline.enqueueOffline("entries.start", start("new field"), "temp-1", A.id);
      listAnswer = async () => [A, B];
      // The level is learned only after the row was judged: rows are read
      // against the level known at flush start, so pretend the server is
      // current, then refuse the field it does not know as a 400.
      const rows = await offline.getOfflineQueue().list();
      const row = rows[0]!;
      await offline.getOfflineQueue().clear();
      const storage = window.localStorage;
      storage.setItem(
        "trackyourtime.offline-queue",
        JSON.stringify({ v: 1, data: [{ ...row, apiLevel: API_LEVEL + 1 }] }),
      );
      offline.__resetOfflineQueueForTests();
      at(API_LEVEL);
      failNext.set(
        "entries.start:new field",
        Object.assign(new Error("Invalid input"), { data: { code: "BAD_REQUEST", httpStatus: 400 } }),
      );

      const { result } = renderQueue();
      await act(async () => {
        await result.current.flush();
      });
      expect(toastError).not.toHaveBeenCalled();
      const kept = await offline.getOfflineQueue().list();
      expect(kept.map((it) => it.hold?.reason ?? null)).toEqual(["server-too-old"]);
    } finally {
      reset();
    }
  });
});
