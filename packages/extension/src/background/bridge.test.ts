/**
 * The extension's half of the web app ↔ extension bridge: who may talk to it,
 * and every row of the decision tables for a web sign-in, a web sign-out and
 * a web account switch.
 */
import {
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_DEVICE_RETRY_MS,
  EXTENSION_SIGN_OUT_MARKER_TTL_MS,
  extensionBridgeDeviceApprovedRequest,
  extensionBridgeSyncRequest,
  type ExtensionBridgeReply,
  type ExtensionBridgeWebSession,
} from "@starter/shared/extension-bridge";
import type { OfflineStartInput } from "@starter/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  loadPendingDeviceAuth,
  savePendingDeviceAuth,
  type PendingDeviceAuth,
} from "../lib/device-auth-store";
import { loadSession, saveSession } from "../lib/session";
import {
  loadLinkBlock,
  loadSignOutMarker,
  saveLinkBlock,
  saveSignOutMarker,
} from "../lib/sign-out-marker";
import {
  API,
  createFakeAuthServer,
  installFakeAuthServer,
  type FakeAuthServer,
} from "../test/fake-auth-server";
import {
  handleBridgeRequest,
  isWebAppOrigin,
  registerBridgeListener,
  screenExternalMessage,
} from "./bridge";
import {
  enqueueOffline,
  forgetRejectedSession,
  getOfflineQueue,
  listHeldRows,
  pendingSyncCount,
  reload,
} from "./runtime";

const WEB = "http://localhost:3392";
const U = "user-u";
const V = "user-v";

let server: FakeAuthServer;

const page = { origin: WEB, frameId: 0, tab: { id: 1 } } as chrome.runtime.MessageSender;

const signedIn = (userId: string, createdAt = Date.now() - 60_000): ExtensionBridgeWebSession => ({
  userId,
  sessionCreatedAt: createdAt,
});

const signedOut: ExtensionBridgeWebSession = { userId: null, sessionCreatedAt: null };

/** Send a request the way a page does, through the sender checks. */
const send = async (message: unknown, origin = WEB): Promise<ExtensionBridgeReply | undefined> => {
  const screened = screenExternalMessage(message, { origin, frameId: 0, tab: { id: 1 } }, "development");
  if (!screened.ok) return screened.reply;
  return handleBridgeRequest(screened.request, screened.origin, { retryDelayMs: 0 }, "development");
};

const sync = (web: ExtensionBridgeWebSession, apiOrigin = API): Promise<ExtensionBridgeReply | undefined> =>
  send(extensionBridgeSyncRequest(apiOrigin, web));

const approved = (requestId: string, outcome: "approved" | "failed" = "approved") =>
  send(extensionBridgeDeviceApprovedRequest(API, requestId, outcome));

const actionOf = (reply: ExtensionBridgeReply | undefined) => {
  if (reply?.kind !== "sync-result") throw new Error(`not a sync reply: ${JSON.stringify(reply)}`);
  return reply.action;
};

const statusOf = (reply: ExtensionBridgeReply | undefined) => {
  if (reply?.kind !== "device-result") throw new Error(`not a device reply: ${JSON.stringify(reply)}`);
  return reply.status;
};

/** Link the extension to `userId` through the whole bridge exchange. */
const link = async (userId: string, email = `${userId}@example.com`): Promise<void> => {
  server.approvedUser = { id: userId, email };
  const action = actionOf(await sync(signedIn(userId)));
  if (action.type !== "approve-device") throw new Error(`expected approve-device, got ${action.type}`);
  server.token = "approved";
  expect(statusOf(await approved(action.requestId))).toBe("signed-in");
};

const startInput = (description: string): OfflineStartInput => ({
  description,
  projectId: null,
  taskId: null,
  tagIds: [],
  billable: false,
  start: "2026-09-14T09:00:00.000Z",
  source: "extension",
  timeZone: "UTC",
  originId: "origin-test",
});

beforeEach(async () => {
  server = createFakeAuthServer();
  installFakeAuthServer(server);
  await reload();
  await getOfflineQueue().clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── who may talk to the extension ────────────────────────────────────

describe("the sender", () => {
  const request = extensionBridgeSyncRequest(API, signedOut);

  test("a page outside the build's allowlist gets no reply at all", () => {
    expect(screenExternalMessage(request, { origin: "https://evil.example", frameId: 0, tab: {} }, "development")).toEqual({
      ok: false,
      reply: undefined,
    });
    // A production build never takes a local page.
    expect(screenExternalMessage(request, { origin: WEB, frameId: 0, tab: {} }, "production").ok).toBe(false);
    expect(
      screenExternalMessage(request, { origin: "https://trackyourtime.dev", frameId: 0, tab: {} }, "production").ok,
    ).toBe(true);
  });

  test("another extension, or a sender with no tab, gets no reply", () => {
    expect(screenExternalMessage(request, { origin: WEB, id: "other-extension", frameId: 0, tab: {} }, "development").ok).toBe(false);
    expect(screenExternalMessage(request, { origin: WEB, frameId: 0 }, "development").ok).toBe(false);
  });

  test("a frame, or an incognito tab, gets no reply", () => {
    // A cross-site frame of the web app has no session cookie and would
    // describe a signed-out web app.
    expect(screenExternalMessage(request, { origin: WEB, frameId: 3, tab: {} }, "development")).toEqual({
      ok: false,
      reply: undefined,
    });
    expect(screenExternalMessage(request, { origin: WEB, tab: {} }, "development").ok).toBe(false);
    expect(
      screenExternalMessage(request, { origin: WEB, frameId: 0, tab: { incognito: true } }, "development").ok,
    ).toBe(false);
  });

  test("a message of an unknown version is answered with the versions this build reads", () => {
    const result = screenExternalMessage(
      { channel: EXTENSION_BRIDGE_CHANNEL, v: 99, kind: "sync" },
      { origin: WEB, frameId: 0, tab: {} },
      "development",
    );
    expect(result).toMatchObject({ ok: false, reply: { kind: "unsupported", supported: [1] } });
  });

  test("a malformed or foreign message gets no reply", () => {
    expect(screenExternalMessage({ hello: 1 }, page, "development")).toEqual({ ok: false, reply: undefined });
    expect(
      screenExternalMessage({ ...request, web: { userId: 5 } }, page, "development"),
    ).toEqual({ ok: false, reply: undefined });
  });

  test("a page for another server is ignored, and the extension stays where it is", async () => {
    expect(actionOf(await sync(signedIn(U), "https://track.example.com"))).toEqual({
      type: "none",
      reason: "other-server",
    });
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  test("a page that is not this server's web app is refused", async () => {
    expect(actionOf(await send(extensionBridgeSyncRequest(API, signedIn(U)), "http://localhost:4000"))).toEqual({
      type: "none",
      reason: "origin-mismatch",
    });
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  test("a development build takes localhost and 127.0.0.1 as one host, on the same port", () => {
    expect(isWebAppOrigin("http://127.0.0.1:3392", WEB, "development")).toBe(true);
    expect(isWebAppOrigin("http://127.0.0.1:3393", WEB, "development")).toBe(false);
    expect(isWebAppOrigin("http://127.0.0.1:3392", WEB, "production")).toBe(false);
  });

  test("no web app address means no decision", async () => {
    server.healthFails = true;
    await reload();
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "server-unavailable" });
  });

  test("the registered listener answers a page and stays silent for a stranger", async () => {
    registerBridgeListener();
    const reply = await fakeChrome.sendExternal(extensionBridgeSyncRequest(API, signedOut), page);
    expect(reply).toMatchObject({ kind: "sync-result", action: { type: "none", reason: "signed-out" } });
    const silent = await fakeChrome.sendExternal(extensionBridgeSyncRequest(API, signedOut), {
      origin: "https://evil.example",
      tab: page.tab,
    });
    expect(silent).toBeUndefined();
  });
});

// ── (a) the web app signs in ─────────────────────────────────────────

describe("web sign-in", () => {
  test("a signed-out extension starts a device authorization and hands the page its code", async () => {
    const action = actionOf(await sync(signedIn(U)));
    expect(action).toMatchObject({ type: "approve-device", userCode: "ABCDEFGH" });
    const record = await loadPendingDeviceAuth();
    expect(record).toMatchObject({ purpose: "web-link", forUserId: U, apiOrigin: API });
    // The device code never leaves the extension.
    expect(JSON.stringify(action)).not.toContain(record?.deviceCode);
  });

  test("the approval signs the extension in with a session of its own, as the page's user", async () => {
    await link(U);
    expect(await loadSession()).toMatchObject({
      token: "token-1",
      userId: U,
      email: `${U}@example.com`,
      source: "web",
    });
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "linked" });
  });

  test("a second tab reuses the code instead of starting another authorization", async () => {
    const first = actionOf(await sync(signedIn(U)));
    const second = actionOf(await sync(signedIn(U)));
    expect(second).toEqual(first);
    expect(server.calls.filter((path) => path === "/api/auth/device/code")).toHaveLength(1);
  });

  test("an approval the page's reply was lost for still links on the next sync", async () => {
    const first = actionOf(await sync(signedIn(U)));
    server.approvedUser = { id: U, email: `${U}@example.com` };
    server.token = "approved";
    // The same code again, and no poll of its own: a poll here would put the
    // page's `device-approved` exchange inside the server's polling interval.
    server.calls = [];
    const again = actionOf(await sync(signedIn(U)));
    expect(again).toEqual(first);
    expect(server.calls).not.toContain("/api/auth/device/token");
    if (again.type !== "approve-device") throw new Error("expected a code");
    expect(statusOf(await approved(again.requestId))).toBe("signed-in");
    expect((await loadSession())?.source).toBe("web");
  });

  test("a token that belongs to somebody else is revoked and never kept", async () => {
    const action = actionOf(await sync(signedIn(U)));
    if (action.type !== "approve-device") throw new Error("expected a code");
    server.approvedUser = { id: V, email: "v@example.com" };
    server.token = "approved";
    expect(statusOf(await approved(action.requestId))).toBe("failed");
    expect(server.revoked).toEqual(["token-1"]);
    expect(await loadSession()).toBeNull();
    expect(await loadPendingDeviceAuth()).toBeNull();
  });

  test("not yet approved answers pending and keeps the authorization", async () => {
    const action = actionOf(await sync(signedIn(U)));
    if (action.type !== "approve-device") throw new Error("expected a code");
    expect(statusOf(await approved(action.requestId))).toBe("pending");
    expect(await loadPendingDeviceAuth()).not.toBeNull();
  });

  test("an unknown request id is refused", async () => {
    actionOf(await sync(signedIn(U)));
    expect(statusOf(await approved("zzzzzzzzzzzzzzzzzzzzzzzz"))).toBe("failed");
    expect(await loadPendingDeviceAuth()).not.toBeNull();
  });

  test("a page that could not approve ends it, and the extension backs off", async () => {
    const action = actionOf(await sync(signedIn(U)));
    if (action.type !== "approve-device") throw new Error("expected a code");
    expect(statusOf(await approved(action.requestId, "failed"))).toBe("failed");
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "backing-off" });
  });

  test("a denied or expired code ends it", async () => {
    const action = actionOf(await sync(signedIn(U)));
    if (action.type !== "approve-device") throw new Error("expected a code");
    server.token = "expired";
    expect(statusOf(await approved(action.requestId))).toBe("expired");
    expect(await loadPendingDeviceAuth()).toBeNull();
  });

  test("a server that will not start an authorization is backed off from", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    server.deviceCodeFails = true;
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "server-unavailable" });
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "backing-off" });
    server.deviceCodeFails = false;
    vi.setSystemTime(Date.now() + EXTENSION_BRIDGE_DEVICE_RETRY_MS + 1);
    expect(actionOf(await sync(signedIn(U)))).toMatchObject({ type: "approve-device" });
  });

  test("a code started for another user is dropped, and a new one is started", async () => {
    actionOf(await sync(signedIn(U)));
    const action = actionOf(await sync(signedIn(V)));
    expect(action).toMatchObject({ type: "approve-device" });
    expect((await loadPendingDeviceAuth())?.forUserId).toBe(V);
  });

  test("a device sign-in the popup started is not raced by a second one", async () => {
    const manual: PendingDeviceAuth = {
      requestId: "manualmanualmanualmanual",
      deviceCode: "device-manual",
      userCode: "WXYZWXYZ",
      apiOrigin: API,
      purpose: "manual",
      forUserId: null,
      expiresAt: Date.now() + 600_000,
      intervalSeconds: 5,
    };
    await savePendingDeviceAuth(manual);
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "backing-off" });
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  for (const source of ["password", "device"] as const) {
    test(`a ${source} session is never displaced by the web app`, async () => {
      await saveSession({ token: "mine", userId: V, email: null, source });
      await reload();
      expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "explicit-session" });
      expect(actionOf(await sync(signedOut))).toEqual({ type: "none", reason: "explicit-session" });
      expect((await loadSession())?.token).toBe("mine");
      expect(server.revoked).toEqual([]);
    });
  }
});

// ── (b) the web app signs out ────────────────────────────────────────

describe("web sign-out", () => {
  test("signs a linked extension out, revokes its own session and keeps the queue", async () => {
    await link(U);
    // Nothing can be sent: the network is gone for tRPC.
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("kept"), "tmp_1");
    expect((await getOfflineQueue().list())[0]?.owner).toBe(U);

    expect(actionOf(await sync(signedOut))).toEqual({ type: "none", reason: "signed-out" });
    expect(await loadSession()).toBeNull();
    expect(server.revoked).toContain("token-1");
    expect(await getOfflineQueue().size()).toBe(1);
  });

  test("sends what it can before leaving", async () => {
    await link(U);
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("sent on the way out"), "tmp_1");
    server.mutationsFail = false;
    expect(actionOf(await sync(signedOut))).toEqual({ type: "none", reason: "signed-out" });
    expect(await getOfflineQueue().size()).toBe(0);
    expect(server.calls).toContain("/api/trpc/entries.start");
  });

  test("a signed-out extension has nothing to do, and a web-link code is dropped", async () => {
    actionOf(await sync(signedIn(U)));
    expect(actionOf(await sync(signedOut))).toEqual({ type: "none", reason: "signed-out" });
    expect(await loadPendingDeviceAuth()).toBeNull();
  });
});

// ── (d) the web app switches accounts ────────────────────────────────

describe("web account switch", () => {
  test("leaves the old account, holds its queued rows, and links the new one", async () => {
    await link(U);
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("U's work"), "tmp_1");

    const action = actionOf(await sync(signedIn(V)));
    expect(action).toMatchObject({ type: "approve-device" });
    expect(server.revoked).toContain("token-1");
    expect(await loadSession()).toBeNull();

    if (action.type !== "approve-device") throw new Error("expected a code");
    // The network is back: only the owner check keeps U's row from V's account.
    server.mutationsFail = false;
    server.calls = [];
    server.approvedUser = { id: V, email: "v@example.com" };
    server.token = "approved";
    expect(statusOf(await approved(action.requestId))).toBe("signed-in");
    expect((await loadSession())?.userId).toBe(V);
    expect(server.calls).not.toContain("/api/trpc/entries.start");

    // U's row is still there, held for U, and not ahead of V's work.
    expect(await getOfflineQueue().size()).toBe(1);
    expect(await pendingSyncCount()).toBe(0);
    expect((await listHeldRows()).map((row) => row.hold)).toEqual(["other-account"]);
  });
});

// ── (c) the extension signed out on purpose ──────────────────────────

describe("the sign-out marker", () => {
  test("asks the same person's older web session to sign out", async () => {
    const at = Date.now() - 1_000;
    await saveSignOutMarker({ userId: U, apiOrigin: API, at });
    expect(actionOf(await sync(signedIn(U, at - 60_000)))).toEqual({ type: "sign-out-web", at });
    // Kept until the web app has actually signed out.
    expect(await loadSignOutMarker()).not.toBeNull();
    expect(actionOf(await sync(signedOut))).toEqual({ type: "none", reason: "signed-out" });
    expect(await loadSignOutMarker()).toBeNull();
  });

  test("a web session newer than the sign-out deletes it and links as usual", async () => {
    const at = Date.now() - 60_000;
    await saveSignOutMarker({ userId: U, apiOrigin: API, at });
    expect(actionOf(await sync(signedIn(U, at + 1_000)))).toMatchObject({ type: "approve-device" });
    expect(await loadSignOutMarker()).toBeNull();
  });

  test("never signs out another account", async () => {
    await saveSignOutMarker({ userId: V, apiOrigin: API, at: Date.now() });
    expect(actionOf(await sync(signedIn(U, Date.now() - 60_000)))).toMatchObject({
      type: "approve-device",
    });
    expect(await loadSignOutMarker()).toBeNull();
  });

  test("expires", async () => {
    const at = Date.now() - EXTENSION_SIGN_OUT_MARKER_TTL_MS - 1;
    await saveSignOutMarker({ userId: U, apiOrigin: API, at });
    expect(actionOf(await sync(signedIn(U, at - 1)))).toMatchObject({ type: "approve-device" });
    expect(await loadSignOutMarker()).toBeNull();
  });

  test("a successful link deletes it", async () => {
    await link(U);
    expect(await loadSignOutMarker()).toBeNull();
  });
});

describe("the link block", () => {
  test("no web session from before an explicit sign-out links the extension, whoever it belongs to", async () => {
    const at = Date.now() - 1_000;
    // The marker named U; the web app is signed in as V, from before.
    await saveSignOutMarker({ userId: U, apiOrigin: API, at });
    await saveLinkBlock({ apiOrigin: API, at });
    expect(actionOf(await sync(signedIn(V, at - 60_000)))).toEqual({
      type: "none",
      reason: "explicit-sign-out",
    });
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  test("does not expire with the marker", async () => {
    const at = Date.now() - EXTENSION_SIGN_OUT_MARKER_TTL_MS - 60_000;
    await saveLinkBlock({ apiOrigin: API, at });
    expect(actionOf(await sync(signedIn(U, at - 1)))).toEqual({
      type: "none",
      reason: "explicit-sign-out",
    });
  });

  test("a web sign-in after it links as usual, and the link clears it", async () => {
    const at = Date.now() - 60_000;
    await saveLinkBlock({ apiOrigin: API, at });
    server.approvedUser = { id: U, email: `${U}@example.com` };
    const action = actionOf(await sync(signedIn(U, at + 1_000)));
    if (action.type !== "approve-device") throw new Error("expected a code");
    server.token = "approved";
    expect(statusOf(await approved(action.requestId))).toBe("signed-in");
    expect(await loadLinkBlock()).toBeNull();
  });

  test("says nothing about another server", async () => {
    await saveLinkBlock({ apiOrigin: "https://track.example.com", at: Date.now() });
    expect(actionOf(await sync(signedIn(U, Date.now() - 60_000)))).toMatchObject({
      type: "approve-device",
    });
  });
});

describe("a refused token", () => {
  test("drops a linked session but keeps its queued rows", async () => {
    await link(U);
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("kept"), "tmp_1");
    await forgetRejectedSession();
    expect(await loadSession()).toBeNull();
    expect(await getOfflineQueue().size()).toBe(1);
  });

  test("forgets any other session whole, queue included", async () => {
    await saveSession({ token: "pw", userId: U, email: null, source: "password" });
    await reload();
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("dropped"), "tmp_1");
    await forgetRejectedSession();
    expect(await loadSession()).toBeNull();
    expect(await getOfflineQueue().size()).toBe(0);
  });
});
