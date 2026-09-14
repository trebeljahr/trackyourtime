import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineStartInput } from "@starter/core";

/**
 * `deleteAccount` against the real offline queue.
 *
 * The rule under test is the opposite of sign-out's. A signed-out person can
 * sign back in and send what they queued, so sign-out keeps those rows; a
 * deleted account cannot, so its rows must go — and must never be left to
 * replay under whoever signs in next. Just as important is the other half:
 * a refused deletion (wrong password, no network) touches nothing local,
 * because the account and everything it queued still exist.
 */

type AuthResult = { data: unknown; error: { code?: string } | null };
let deleteResult: AuthResult = { data: { success: true }, error: null };
let accountsResult: AuthResult = { data: [{ providerId: "credential" }], error: null };
const deleteUser = vi.fn<(body: unknown) => Promise<AuthResult>>(async () => deleteResult);

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    deleteUser: (body: unknown) => deleteUser(body),
    listAccounts: async () => accountsResult,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    useSession: vi.fn(),
    getSession: vi.fn(),
  }),
}));
vi.mock("better-auth/client/plugins", () => ({
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

const {
  __resetOfflineQueueForTests,
  __resetOfflineQueueOwnerForTests,
  enqueueOffline,
  getOfflineQueue,
  sealOfflineQueueOwner,
  setOfflineQueueOwner,
} = await import("./offline");
const { accountHasPassword, deleteAccount } = await import("./auth-client");

const startInput = (description: string): OfflineStartInput => ({
  description,
  projectId: null,
  taskId: null,
  billable: true,
  start: "2026-08-21T09:00:00.000Z",
  source: "web",
  timeZone: "Europe/Berlin",
  originId: "tab-1",
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetOfflineQueueForTests();
  __resetOfflineQueueOwnerForTests();
  deleteResult = { data: { success: true }, error: null };
  accountsResult = { data: [{ providerId: "credential" }], error: null };

  // Somebody else's unsynced start, left on this device, then Alice's own.
  await setOfflineQueueOwner("user-b");
  await enqueueOffline("entries.start", startInput("B's work"), "temp-b");
  await sealOfflineQueueOwner();
  await setOfflineQueueOwner("user-a");
  await enqueueOffline("entries.start", startInput("A's work"), "temp-a");
});

const owners = async (): Promise<Array<string | undefined>> =>
  (await getOfflineQueue().list()).map((row) => row.owner);

describe("deleteAccount", () => {
  it("sends the password, then drops the account's queue, mirror and token", async () => {
    const result = await deleteAccount({ userId: "user-a", password: "hunter22" });

    expect(result).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith({ password: "hunter22" });
    expect(await owners()).toEqual(["user-b"]);
    expect(writeRunningMirror).toHaveBeenCalledWith(null);
    expect(clearNativeToken).toHaveBeenCalledOnce();
  });

  it("sends no password field at all for an account without one", async () => {
    await deleteAccount({ userId: "user-a" });
    expect(deleteUser).toHaveBeenCalledWith({});
  });

  it.each([
    ["PASSWORD_REQUIRED", "password-required"],
    ["INVALID_PASSWORD", "invalid-password"],
    ["SESSION_EXPIRED", "session-expired"],
    ["INTERNAL_SERVER_ERROR", "failed"],
  ])("on %s, reports %s and touches nothing on this device", async (code, reason) => {
    deleteResult = { data: null, error: { code } };

    const result = await deleteAccount({ userId: "user-a", password: "x" });

    expect(result).toEqual({ ok: false, reason });
    expect(await owners()).toEqual(["user-b", "user-a"]);
    expect(writeRunningMirror).not.toHaveBeenCalled();
    expect(clearNativeToken).not.toHaveBeenCalled();
  });

  it("treats a request that never got an answer as a failure, not a deletion", async () => {
    deleteUser.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await deleteAccount({ userId: "user-a", password: "x" })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await owners()).toEqual(["user-b", "user-a"]);
  });
});

describe("accountHasPassword", () => {
  it("is false only when the account list says there is no credential account", async () => {
    expect(await accountHasPassword()).toBe(true);
    accountsResult = { data: [{ providerId: "google" }], error: null };
    expect(await accountHasPassword()).toBe(false);
    accountsResult = { data: null, error: { code: "UNAUTHORIZED" } };
    expect(await accountHasPassword()).toBe(true);
  });
});
