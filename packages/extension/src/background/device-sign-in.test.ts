/**
 * "Sign in with the web app" from the popup: the device flow for any server,
 * finished by whatever wakes the worker.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEVICE_AUTH_ALARM,
  loadDeviceSignInError,
  loadPendingDeviceAuth,
} from "../lib/device-auth-store";
import { loadSession } from "../lib/session";
import {
  API,
  createFakeAuthServer,
  installFakeAuthServer,
  type FakeAuthServer,
} from "../test/fake-auth-server";
import {
  attemptPendingDeviceSignIn,
  cancelDeviceSignIn,
  isAllowedVerificationUrl,
  startDeviceSignIn,
} from "./device-sign-in";
import { BackgroundError } from "./errors";
import {
  getOfflineQueue,
  noteServerReachable,
  reload,
  resolveOriginTrusted,
} from "./runtime";
import { buildState } from "./state";

let server: FakeAuthServer;

beforeEach(async () => {
  server = createFakeAuthServer();
  // Long enough that the in-worker loop never fires during a test: the tests
  // drive the exchange the way the alarm and the popup do.
  server.intervalSeconds = 600;
  installFakeAuthServer(server);
  await reload();
  await getOfflineQueue().clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAllowedVerificationUrl", () => {
  test("https anywhere, http only on this machine", () => {
    expect(isAllowedVerificationUrl("https://track.example.com/app/device?user_code=X")).toBe(true);
    expect(isAllowedVerificationUrl("http://localhost:3392/app/device")).toBe(true);
    expect(isAllowedVerificationUrl("http://127.0.0.1:3392/app/device")).toBe(true);
    expect(isAllowedVerificationUrl("http://track.example.com/app/device")).toBe(false);
    expect(isAllowedVerificationUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedVerificationUrl("not a url")).toBe(false);
  });
});

describe("startDeviceSignIn", () => {
  test("opens the approval page, keeps an alarm, and shows the code on the snapshot", async () => {
    await startDeviceSignIn();

    expect(fakeChrome.created).toEqual([server.verificationUrl]);
    expect(fakeChrome.alarms.has(DEVICE_AUTH_ALARM)).toBe(true);
    expect(await loadPendingDeviceAuth()).toMatchObject({ purpose: "manual", forUserId: null });

    const state = await buildState();
    expect(state.signedIn).toBe(false);
    expect(state.pendingDeviceAuth).toEqual({
      userCode: "ABCDEFGH",
      expiresAt: expect.any(Number),
    });
    // Never the device code.
    expect(JSON.stringify(state)).not.toContain("device-1");
  });

  test("refuses an approval page it will not open", async () => {
    server.verificationUrl = "http://track.example.com/app/device";
    await expect(startDeviceSignIn()).rejects.toSatisfy(
      (error: unknown) => error instanceof BackgroundError && error.code === "DEVICE_URL_INVALID",
    );
    expect(fakeChrome.created).toEqual([]);
    expect(await loadPendingDeviceAuth()).toBeNull();
  });

  test("the alarm (or any wake-up) finishes an approved sign-in as a device session", async () => {
    await startDeviceSignIn();
    expect(await attemptPendingDeviceSignIn()).toBe("pending");

    server.token = "approved";
    expect(await attemptPendingDeviceSignIn()).toBe("signed-in");
    expect(await loadSession()).toMatchObject({
      userId: "user-u",
      email: "u@example.com",
      source: "device",
    });
    expect(fakeChrome.alarms.has(DEVICE_AUTH_ALARM)).toBe(false);
    expect(await attemptPendingDeviceSignIn()).toBeNull();
  });

  test("opening the popup finishes it too", async () => {
    await startDeviceSignIn();
    server.token = "approved";
    const state = await buildState();
    expect(state.signedIn).toBe(true);
    expect(state.sessionSource).toBe("device");
  });

  test("slow_down is still waiting", async () => {
    await startDeviceSignIn();
    server.token = "slow";
    expect(await attemptPendingDeviceSignIn()).toBe("pending");
  });

  test("a declined sign-in ends and says so", async () => {
    await startDeviceSignIn();
    server.token = "denied";
    expect(await attemptPendingDeviceSignIn()).toBe("failed");
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(await loadDeviceSignInError()).toBe("denied");
    expect((await buildState()).deviceSignInError).toBe("denied");
  });

  test("an expired code ends and says so", async () => {
    await startDeviceSignIn();
    server.token = "expired";
    expect(await attemptPendingDeviceSignIn()).toBe("expired");
    expect(await loadDeviceSignInError()).toBe("expired");
  });

  test("a code past its lifetime is not even sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await startDeviceSignIn();
      vi.setSystemTime(Date.now() + 1801 * 1000);
      server.calls = [];
      expect(await attemptPendingDeviceSignIn()).toBe("expired");
      expect(server.calls).not.toContain("/api/auth/device/token");
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancel forgets it and its alarm", async () => {
    await startDeviceSignIn();
    await cancelDeviceSignIn();
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(fakeChrome.alarms.has(DEVICE_AUTH_ALARM)).toBe(false);
    expect((await buildState()).pendingDeviceAuth).toBeNull();
  });

  test("an unreachable server leaves it waiting", async () => {
    await startDeviceSignIn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await attemptPendingDeviceSignIn()).toBe("pending");
    expect(await loadPendingDeviceAuth()).not.toBeNull();
  });
});

describe("an origin the server does not trust", () => {
  test("a transport failure re-asks /api/health, and the snapshot says so", async () => {
    server.originTrusted = false;
    noteServerReachable(false);
    await vi.waitFor(async () => {
      expect(await resolveOriginTrusted(API)).toBe(false);
    });
    expect((await buildState()).originTrusted).toBe(false);
  });
});
