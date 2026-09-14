// @vitest-environment jsdom
/**
 * The timesheet grid's writes in a person with several workspaces.
 *
 * The grid patches `entries.list(listInput)`, and that key does not carry the
 * workspace — the tRPC link adds it below React Query. A switch resets the key
 * for the new workspace. So a cell write that began in A and settles after a
 * switch to B must not touch it: restoring A's snapshot would paint A's week
 * into B's grid with nothing to refetch it away, and A's created entry patched
 * in would show under B. A write that fails offline is queued in A, where it
 * was made, not in wherever the device points when the error arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { WorkspaceSummary } from "@starter/core";

let online = true;
vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => online,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

const enqueued: Array<{ op: string; workspaceId: string | null | undefined }> = [];
vi.mock("@/lib/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offline")>();
  return {
    ...actual,
    enqueueOffline: async (
      op: string,
      _input: unknown,
      _tempId?: string,
      workspaceId?: string | null,
    ): Promise<void> => {
      enqueued.push({ op, workspaceId });
    },
  };
});

const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    message: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
let pendingCall: Deferred | null = null;
const listWrites = vi.fn();
const listSnapshot = { entries: [{ id: "a-entry", workspaceId: "ws-a" }] };

vi.mock("@/lib/trpc", () => {
  const asyncNoop = async (): Promise<void> => undefined;
  const mutation = {
    useMutation: () => ({
      mutateAsync: () =>
        new Promise((resolve, reject) => {
          pendingCall = { resolve, reject };
        }),
    }),
  };
  const utils = {
    entries: {
      list: {
        cancel: asyncNoop,
        getData: () => listSnapshot,
        setData: (...args: unknown[]) => listWrites(...args),
      },
      invalidate: asyncNoop,
    },
    reports: { invalidate: asyncNoop },
    projects: { list: { getData: () => [] } },
    tasks: { list: { getData: () => [] } },
    settings: { get: { getData: () => null } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      entries: { create: mutation, update: mutation, remove: mutation },
    },
  };
});

const { QueryClient } = await import("@tanstack/react-query");
const { useTimesheetMutations } = await import("./use-timesheet-mutations");
const activeWorkspace = await import("@/lib/active-workspace");

const summary = (id: string, name: string, isDefault = false): WorkspaceSummary => ({
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
const A = summary("ws-a", "Acme", true);
const B = summary("ws-b", "Beta");

const listInput = { from: "2026-09-14", to: "2026-09-20" };
const createPlan = {
  kind: "create" as const,
  start: "2026-09-14T09:00:00.000Z",
  end: "2026-09-14T11:00:00.000Z",
};
const context = { projectId: null, taskId: null };

/** Start a cell create in A and wait until its request is in flight. */
const beginCreateInA = async () => {
  const { result } = renderHook(() => useTimesheetMutations(listInput));
  await act(async () => {
    result.current.applyPlan(createPlan as never, context);
  });
  await vi.waitFor(() => expect(pendingCall).not.toBeNull());
  listWrites.mockClear();
  await activeWorkspace.switchWorkspace(B.id, { queryClient: new QueryClient() });
  return pendingCall as unknown as Deferred;
};

beforeEach(async () => {
  online = true;
  pendingCall = null;
  enqueued.length = 0;
  listWrites.mockClear();
  toastError.mockClear();
  window.localStorage.clear();
  activeWorkspace.__resetActiveWorkspaceForTests();
  await activeWorkspace.applyWorkspaceList([A, B], "u1");
});

afterEach(cleanup);

describe("timesheet writes across a workspace switch", () => {
  it("does not restore A's snapshot into B's grid when the write is refused", async () => {
    const call = await beginCreateInA();
    await act(async () => {
      call.reject(Object.assign(new Error("Project not found"), { data: { code: "NOT_FOUND" } }));
    });
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(listWrites).not.toHaveBeenCalled();
  });

  it("does not patch A's created entry into B's grid", async () => {
    const call = await beginCreateInA();
    await act(async () => {
      call.resolve({ id: "real-1", workspaceId: A.id, start: createPlan.start, end: createPlan.end });
    });
    // Give the success path a chance to run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listWrites).not.toHaveBeenCalled();
  });

  it("queues an offline failure in the workspace the edit was made in", async () => {
    const call = await beginCreateInA();
    online = false;
    await act(async () => {
      call.reject(new TypeError("Load failed"));
    });
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued).toEqual([{ op: "entries.create", workspaceId: A.id }]);
  });

  it("still patches and restores while the user stays put", async () => {
    const { result } = renderHook(() => useTimesheetMutations(listInput));
    await act(async () => {
      result.current.applyPlan(createPlan as never, context);
    });
    await vi.waitFor(() => expect(pendingCall).not.toBeNull());
    // The optimistic row went in.
    expect(listWrites).toHaveBeenCalled();
    listWrites.mockClear();
    await act(async () => {
      pendingCall?.reject(Object.assign(new Error("bad"), { data: { code: "BAD_REQUEST" } }));
    });
    await vi.waitFor(() => expect(listWrites).toHaveBeenCalledWith(listInput, listSnapshot));
  });
});
