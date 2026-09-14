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
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), message: vi.fn() },
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
