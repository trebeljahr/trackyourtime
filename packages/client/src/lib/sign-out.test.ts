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
    signOut: () => authSignOut(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    useSession: vi.fn(),
    getSession: vi.fn(),
  }),
}));
vi.mock("better-auth/client/plugins", () => ({
  deviceAuthorizationClient: () => ({}),
  twoFactorClient: () => ({}),
}));

vi.mock("@/lib/native-session", () => ({
  clearNativeToken: async () => undefined,
  getNativeToken: () => null,
  setNativeToken: vi.fn(),
}));

const writeRunningMirror = vi.fn<(entry: unknown) => Promise<void>>(async () => undefined);
vi.mock("@/lib/running-mirror", () => ({
  writeRunningMirror: (entry: unknown) => writeRunningMirror(entry),
}));

const { createAppQueryClient } = await import("./query-client");
const { onSignOut, signOut } = await import("./auth-client");
const activeWorkspace = await import("./active-workspace");

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
    writeRunningMirror.mockClear();
    queryClient = createAppQueryClient();
  });

  it("empties the query cache, the running mirror and the workspace choice", async () => {
    await activeWorkspace.applyWorkspaceList([workspace("ws-a", true), workspace("ws-b", false)], "u1");
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);
    queryClient.setQueryData([["entries", "current"], { type: "query" }], { id: "running" });
    const cleanup = vi.fn();
    const unregister = onSignOut(cleanup);

    await signOut();

    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(queryClient.getQueryData([["entries", "current"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
    expect(activeWorkspace.getActiveWorkspaceId()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("still forgets everything when the server never heard the sign-out", async () => {
    authSignOut.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["A's entry"]);

    await expect(signOut()).rejects.toThrow("Failed to fetch");

    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
  });
});
