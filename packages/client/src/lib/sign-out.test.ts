// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@starter/core";

/**
 * Sign-out does not reload the tab. Whatever it leaves behind, the next
 * account to sign in in the same tab is shown: the previous account's cached
 * entries until each query refetches, its running timer until
 * `entries.current` answers (never, offline), its workspace id sent on every
 * request, and — on a phone — its timer seeded again from the mirror at the
 * next cold launch.
 */

const authSignOut = vi.fn(async () => ({ data: { success: true }, error: null }));
vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    $store: { atoms: { session: { get: () => ({ data: null }), set: vi.fn() } } },
    signOut: () => authSignOut(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    useSession: vi.fn(),
    getSession: vi.fn(),
  }),
}));
vi.mock("better-auth/client/plugins", () => ({
  magicLinkClient: () => ({}),
  deviceAuthorizationClient: () => ({}),
  twoFactorClient: () => ({}),
}));

const clearNativeToken = vi.fn(async () => undefined);
vi.mock("@/lib/native-session", () => ({
  clearNativeToken: () => clearNativeToken(),
  getNativeToken: () => null,
  setNativeToken: vi.fn(),
}));

const writeRunningMirror = vi.fn<(entry: unknown) => Promise<void>>(async () => undefined);
vi.mock("@/lib/running-mirror", () => ({
  writeRunningMirror: (entry: unknown) => writeRunningMirror(entry),
}));

// Which of the two sign-outs erases this device's saved private-data unlock.
const lockPrivateData = vi.fn();
const lockAndForgetPrivateData = vi.fn();
vi.mock("./private-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./private-session")>()),
  lockPrivateData: () => lockPrivateData(),
  lockAndForgetPrivateData: () => lockAndForgetPrivateData(),
}));

const { QUERY_SNAPSHOT_KEY } = await import("./query-persistence");
const { createAppQueryClient } = await import("./query-client");
const { onSignOut, signOut, signOutRevokedDevice } = await import("./auth-client");
const activeWorkspace = await import("./active-workspace");
const offline = await import("./offline");

const workspace = (id: string, isDefault: boolean): WorkspaceSummary => ({
  id,
  name: id,
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

describe("signOut", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage.clear();
    activeWorkspace.__resetActiveWorkspaceForTests();
    vi.restoreAllMocks();
    clearNativeToken.mockClear();
    writeRunningMirror.mockClear();
    queryClient = createAppQueryClient();
  });

  it("empties the query cache, the running mirror and the workspace choice", async () => {
    await activeWorkspace.applyWorkspaceList([workspace("ws-a", true), workspace("ws-b", false)], "u1");
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);
    queryClient.setQueryData([["entries", "current"], { type: "query" }], { id: "running" });
    window.localStorage.setItem(QUERY_SNAPSHOT_KEY, "saved catalog");
    const cleanup = vi.fn();
    const unregister = onSignOut(cleanup);

    await signOut();

    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(queryClient.getQueryData([["entries", "current"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
    expect(activeWorkspace.getActiveWorkspaceId()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    unregister();
  });

  it("deletes the desktop app's recorded activity, even when that fails", async () => {
    const forget = vi.fn(async () => {
      throw new Error("ipc");
    });
    (window as unknown as { electronAPI?: unknown }).electronAPI = { isDesktop: true, activity: { forget } };
    try {
      await signOut();
      expect(forget).toHaveBeenCalledTimes(1);
      expect(writeRunningMirror).toHaveBeenCalledWith(null);
    } finally {
      (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
    }
  });

  it("still clears credentials and caches when queue storage fails", async () => {
    await offline.setOfflineQueueOwner("u1");
    await activeWorkspace.applyWorkspaceList([workspace("ws-a", true)], "u1");
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);
    vi.spyOn(offline.getOfflineQueue(), "adoptUnowned").mockRejectedValueOnce(new Error("Storage failed"));
    await expect(signOut()).rejects.toThrow("Storage failed");
    expect(clearNativeToken).toHaveBeenCalledTimes(1);
    expect(offline.getOfflineQueueOwner()).toBeNull();
    expect(activeWorkspace.getActiveWorkspaceId()).toBeNull();
    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
  });

  it("erases the saved private-data unlock when the person signs out", async () => {
    lockPrivateData.mockClear();
    lockAndForgetPrivateData.mockClear();
    await signOut();
    expect(lockAndForgetPrivateData).toHaveBeenCalledTimes(1);
    expect(lockPrivateData).not.toHaveBeenCalled();
  });

  it("keeps it when the server ended the session, and forgets the rest the same way", async () => {
    // After a password reset that saved unlock is the only copy of the keys
    // that still opens; the next sign-in here re-locks them under the new
    // password instead of asking for the recovery key.
    lockPrivateData.mockClear();
    lockAndForgetPrivateData.mockClear();
    window.localStorage.setItem(QUERY_SNAPSHOT_KEY, "saved catalog");
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);

    await signOutRevokedDevice();

    expect(lockPrivateData).toHaveBeenCalledTimes(1);
    expect(lockAndForgetPrivateData).not.toHaveBeenCalled();
    expect(clearNativeToken).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
    expect(window.localStorage.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
  });

  it("still forgets everything when the server never heard the sign-out", async () => {
    window.localStorage.setItem(QUERY_SNAPSHOT_KEY, "saved catalog");
    authSignOut.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);

    await expect(signOut()).rejects.toThrow("Failed to fetch");

    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
    expect(window.localStorage.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
  });
});
