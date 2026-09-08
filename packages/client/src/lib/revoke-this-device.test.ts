import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineStartInput } from "@starter/core";

/**
 * The revocation wired to this app's real storage.
 *
 * The point of this spec is the queue. A device signed out from Settings →
 * Devices may be holding time the server has never seen — rows written while
 * the phone had no signal — and "your session is gone" is a statement about
 * the credential, not a verdict on that time. So the revocation deliberately
 * does NOT clear the queue: the rows stay, in order, and replay after the
 * next sign-in, exactly as they do after an ordinary expiry. The user is told
 * how many are waiting rather than being left to discover the difference.
 *
 * The queue here is the real one from `lib/offline.ts`, not a stand-in, so a
 * later change that drains it on sign-out fails this rather than passing on a
 * mock that was never asked.
 */

const signOut = vi.fn(async () => undefined);
vi.mock("@/lib/auth-client", () => ({ signOut: () => signOut() }));

const clearNativeToken = vi.fn(async () => undefined);
vi.mock("@/lib/native-session", () => ({
  clearNativeToken: () => clearNativeToken(),
}));

const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

const { clearOfflineQueue, enqueueOffline, getOfflineQueue, getPendingCount } =
  await import("./offline");
const { revokeThisDevice } = await import("./revoke-this-device");
const { __resetSessionRevokedForTests, consumeSessionRevokedNotice } =
  await import("./session-revoked");

const startInput: OfflineStartInput = {
  description: "Wrote tests",
  projectId: "p1",
  taskId: null,
  billable: true,
  start: "2026-08-21T09:00:00.000Z",
  source: "web",
  timeZone: "Europe/Berlin",
  originId: "tab-1",
};

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSessionRevokedForTests();
  await clearOfflineQueue();
});

describe("revokeThisDevice", () => {
  it("keeps the queued time and says how much of it is waiting", async () => {
    await enqueueOffline("entries.start", startInput, "temp-1");
    await enqueueOffline("entries.stop", {
      end: "2026-08-21T10:00:00.000Z",
      originId: "tab-1",
    });
    expect(getPendingCount()).toBe(2);

    const redirect = vi.fn();
    await revokeThisDevice(redirect);

    // The credential is gone — both halves of it.
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clearNativeToken).toHaveBeenCalledTimes(1);

    // The user is told, here and again on the screen they land on.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe("You were signed out");
    expect(
      (toastError.mock.calls[0][1] as { description: string }).description,
    ).toContain("2 unsent changes");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(consumeSessionRevokedNotice()).toEqual({ pending: 2 });

    // And the tracked time is still here, in order, waiting for a sign-in.
    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.op)).toEqual([
      "entries.start",
      "entries.stop",
    ]);
  });

  it("says nothing about a queue when there is nothing queued", async () => {
    const redirect = vi.fn();
    await revokeThisDevice(redirect);

    expect(
      (toastError.mock.calls[0][1] as { description: string }).description,
    ).toContain("Sign in again");
    expect(await getOfflineQueue().size()).toBe(0);
  });

  it("still signs the device out when the sign-out request fails", async () => {
    signOut.mockRejectedValueOnce(new Error("401 — session already gone"));
    const redirect = vi.fn();

    await revokeThisDevice(redirect);

    expect(clearNativeToken).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
