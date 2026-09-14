import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSessionRevokedForTests,
  consumeSessionRevokedNotice,
  handleSessionRevoked,
  type SessionRevokedDeps,
} from "./session-revoked";

/**
 * What a device does when the server says its session is gone.
 *
 * The decisions live here rather than in the hook so they can be driven
 * without a Keychain, a cookie jar or a router: forget the credential, keep
 * the queued time, say so, and land the user on the login screen.
 */

const deps = () => {
  const calls: string[] = [];
  const spies = {
    pendingCount: vi.fn(async () => {
      calls.push("pendingCount");
      return 2;
    }),
    signOut: vi.fn(async () => {
      calls.push("signOut");
      return undefined;
    }),
    clearToken: vi.fn(async () => {
      calls.push("clearToken");
    }),
    notify: vi.fn(() => calls.push("notify")),
    redirect: vi.fn(() => calls.push("redirect")),
  };
  return { calls, spies: spies as unknown as SessionRevokedDeps & typeof spies };
};

beforeEach(() => {
  __resetSessionRevokedForTests();
});

describe("handleSessionRevoked", () => {
  it("forgets the credential, tells the user and sends them to /login", async () => {
    const { calls, spies } = deps();

    await handleSessionRevoked(spies);

    // The count is taken before anything else, because every later step can
    // fail and the number is what the login screen says out loud.
    expect(calls).toEqual([
      "pendingCount",
      "signOut",
      "clearToken",
      "notify",
      "redirect",
    ]);
    expect(spies.notify).toHaveBeenCalledWith({ pending: 2 });
  });

  it("reconnects instead of signing out when the session was only replaced", async () => {
    const { calls, spies } = deps();
    const resume = vi.fn();

    await handleSessionRevoked({ ...spies, stillSignedIn: async () => true, resume });

    // Switching two-factor on or off rotates the session: the socket's old
    // one is gone, the device's credential is not.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(consumeSessionRevokedNotice()).toBeNull();
  });

  it("signs out when the current credential is gone too, or cannot be checked", async () => {
    for (const stillSignedIn of [async () => false, async () => Promise.reject(new Error("offline"))]) {
      __resetSessionRevokedForTests();
      const { calls, spies } = deps();
      const resume = vi.fn();

      await handleSessionRevoked({ ...spies, stillSignedIn, resume });

      expect(resume).not.toHaveBeenCalled();
      expect(calls).toEqual(["pendingCount", "signOut", "clearToken", "notify", "redirect"]);
    }
  });

  it("clears the token even when the sign-out request fails", async () => {
    const { spies } = deps();
    // Expected, not exceptional: the session this would end is the one the
    // server has already thrown away, so the request 401s.
    spies.signOut.mockRejectedValueOnce(new Error("401"));

    await handleSessionRevoked(spies);

    expect(spies.clearToken).toHaveBeenCalledTimes(1);
    expect(spies.redirect).toHaveBeenCalledTimes(1);
  });

  it("still signs out when the queue cannot be counted", async () => {
    const { spies } = deps();
    spies.pendingCount.mockRejectedValueOnce(new Error("storage is gone"));

    await handleSessionRevoked(spies);

    expect(spies.notify).toHaveBeenCalledWith({ pending: 0 });
    expect(spies.clearToken).toHaveBeenCalledTimes(1);
    expect(spies.redirect).toHaveBeenCalledTimes(1);
  });

  it("runs once for concurrent calls", async () => {
    const { spies } = deps();

    await Promise.all([
      handleSessionRevoked(spies),
      handleSessionRevoked(spies),
    ]);

    expect(spies.signOut).toHaveBeenCalledTimes(1);
    expect(spies.redirect).toHaveBeenCalledTimes(1);
  });

  it("leaves a notice for the login screen, readable exactly once", async () => {
    const { spies } = deps();
    expect(consumeSessionRevokedNotice()).toBeNull();

    await handleSessionRevoked(spies);

    expect(consumeSessionRevokedNotice()).toEqual({ pending: 2 });
    // A second visit to /login in the same session is not another revocation.
    expect(consumeSessionRevokedNotice()).toBeNull();
  });

  it("can report a second revocation later in the same launch", async () => {
    const first = deps();
    await handleSessionRevoked(first.spies);

    const second = deps();
    await handleSessionRevoked(second.spies);

    expect(second.spies.redirect).toHaveBeenCalledTimes(1);
  });
});
