// @vitest-environment jsdom
/**
 * The active workspace, as the web app and the phone shells resolve it.
 *
 * Every request is addressed with what this store answers, so what these pin
 * is that it only ever answers a workspace the account is in, that a switch
 * leaves nothing of the old workspace on screen, and that losing access is
 * noticed and said rather than turned into a wall of NOT_FOUNDs.
 */
import { ACTIVE_WORKSPACE_STORAGE_KEY, type WorkspaceSummary } from "@starter/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), message: vi.fn() },
}));

const {
  __resetActiveWorkspaceForTests,
  applyWorkspaceList,
  clearActiveWorkspace,
  getActiveWorkspaceId,
  KNOWN_WORKSPACES_STORAGE_KEY,
  noteNotFound,
  registerWorkspaceListRefetch,
  resolveActiveWorkspaceId,
  switchWorkspace,
  workspaceNameFor,
} = await import("./active-workspace");
const { takeWorkspaceListFor } = await import("@/hooks/use-offline-queue");
const { __resetOfflineQueueForTests, __resetOfflineQueueOwnerForTests } =
  await import("./offline");

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

const entriesKey = [["entries", "list"], { input: { limit: 50 }, type: "query" }];
const workspacesKey = [["workspaces", "list"], { type: "query" }];

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveWorkspaceForTests();
  __resetOfflineQueueForTests();
  __resetOfflineQueueOwnerForTests();
  toastError.mockClear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("resolveActiveWorkspaceId", () => {
  it("keeps a stored id that is still a membership", () => {
    expect(resolveActiveWorkspaceId(B.id, [A, B])).toBe(B.id);
  });

  it("falls back to the default for an id that is not", () => {
    expect(resolveActiveWorkspaceId("ws-gone", [A, B])).toBe(A.id);
    expect(resolveActiveWorkspaceId(null, [B, A])).toBe(A.id);
  });

  it("uses the stored id as it is while no list has ever been seen", () => {
    expect(resolveActiveWorkspaceId(B.id, null)).toBe(B.id);
  });
});

describe("the stored choice", () => {
  it("is validated against the last known list before anything is sent", () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-gone");
    window.localStorage.setItem(
      KNOWN_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        userId: "u1",
        server: window.location.origin,
        workspaces: [A, B],
        names: {},
      }),
    );
    // Synchronous on web: the tRPC link reads this with no await.
    expect(getActiveWorkspaceId()).toBe(A.id);
  });

  it("belonging to another account is not carried over", async () => {
    await applyWorkspaceList([A, B], "u1");
    await switchWorkspace(B.id, { queryClient: new QueryClient() });
    const outcome = await applyWorkspaceList([workspace("ws-c", "Cee", true), B], "u2");
    expect(outcome.activeId).toBe("ws-c");
    expect(outcome.lost).toBeNull();
  });

  it("is forgotten, with the list, on sign-out", async () => {
    await applyWorkspaceList([A, B], "u1");
    await switchWorkspace(B.id, { queryClient: new QueryClient() });
    await clearActiveWorkspace();
    expect(getActiveWorkspaceId()).toBeNull();
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)).toBeNull();
    expect(workspaceNameFor(A.id)).toBeNull();
  });
});

describe("switchWorkspace", () => {
  it("drops the old workspace's cached answers and keeps the person's", async () => {
    await applyWorkspaceList([A, B], "u1");
    const queryClient = new QueryClient();
    queryClient.setQueryData(entriesKey, { entries: ["from A"] });
    queryClient.setQueryData(workspacesKey, [A, B]);
    const setActive = vi.fn(async () => ({ workspaceId: B.id }));

    await switchWorkspace(B.id, { queryClient, setActive });

    expect(getActiveWorkspaceId()).toBe(B.id);
    expect(queryClient.getQueryData(entriesKey)).toBeUndefined();
    expect(queryClient.getQueryData(workspacesKey)).toEqual([A, B]);
    expect(setActive).toHaveBeenCalledWith(B.id);
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe(B.id);
  });

  it("refuses a workspace the account is not in", async () => {
    await applyWorkspaceList([A, B], "u1");
    await switchWorkspace("ws-foreign", { queryClient: new QueryClient() });
    expect(getActiveWorkspaceId()).toBe(A.id);
  });

  it("still switches when telling the server fails", async () => {
    await applyWorkspaceList([A, B], "u1");
    await switchWorkspace(B.id, {
      queryClient: new QueryClient(),
      setActive: async () => {
        throw new Error("offline");
      },
    });
    expect(getActiveWorkspaceId()).toBe(B.id);
  });
});

describe("losing access", () => {
  it("falls back to the default, clears the caches and says which workspace went", async () => {
    await applyWorkspaceList([A, B], "u1");
    const queryClient = new QueryClient();
    await switchWorkspace(B.id, { queryClient });
    queryClient.setQueryData(entriesKey, { entries: ["from B"] });

    // membership.changed → workspaces.list refetched → B is gone.
    await takeWorkspaceListFor([A], "u1", queryClient);

    expect(getActiveWorkspaceId()).toBe(A.id);
    expect(queryClient.getQueryData(entriesKey)).toBeUndefined();
    expect(toastError).toHaveBeenCalledWith("You no longer have access to Beta");
  });

  it("says nothing for a first list or an unchanged one", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(entriesKey, { entries: ["x"] });
    await takeWorkspaceListFor([A, B], "u1", queryClient);
    await takeWorkspaceListFor([A, B], "u1", queryClient);
    expect(toastError).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(entriesKey)).toEqual({ entries: ["x"] });
  });

  it("re-asks for the list on a NOT_FOUND, at most once per burst", () => {
    const refetch = vi.fn();
    const unregister = registerWorkspaceListRefetch(refetch);
    noteNotFound(10_000);
    noteNotFound(10_500);
    noteNotFound(20_000);
    expect(refetch).toHaveBeenCalledTimes(2);
    unregister();
  });
});
