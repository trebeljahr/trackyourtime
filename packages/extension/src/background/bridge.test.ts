/**
 * The extension's half of the web app ↔ extension bridge: who may talk to it,
 * and every row of the decision tables for a web sign-in, a web sign-out and
 * a web account switch.
 */
import { EXTENSION_RELAY_CHANNEL } from "@starter/shared/extension-relay";
import {
  EXTENSION_BRIDGE_CHANNEL,
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
import { loadWebAccount, WEB_ACCOUNT_TTL_MS } from "../lib/web-account";
import { cancelDeviceSignIn } from "./device-sign-in";
import { buildState } from "./state";
import { loadSession, saveSession } from "../lib/session";
import { LINK_BLOCK_STORAGE_KEY, SIGN_OUT_MARKER_STORAGE_KEY } from "../lib/sign-out-marker";
import {
  API,
  createFakeAuthServer,
  installFakeAuthServer,
  type FakeAuthServer,
} from "../test/fake-auth-server";
import {
  handleBridgeRequest,
  confirmWebAccount,
  isWebAppOrigin,
  registerBridgeListener,
  screenExternalMessage,
  screenRelayMessage,
} from "./bridge";
import {
  enqueueOffline,
  forgetRejectedSession,
  getOfflineQueue,
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
  profile: { email: `${userId}@example.com`, image: "https://api.trackyourtime.dev/api/avatars/test" },
});

const signedOut: ExtensionBridgeWebSession = { userId: null, sessionCreatedAt: null };

/** Send a request the way a page does, through the sender checks. */
const send = async (message: unknown, origin = WEB): Promise<ExtensionBridgeReply | undefined> => {
  const screened = screenExternalMessage(message, { origin, frameId: 0, tab: { id: 1 } }, "development");
  // Both transports must enter the same account/server state machine.
  expect(screenRelayMessage({ channel: EXTENSION_RELAY_CHANNEL, direction: "request", id: "relay-request-1234", payload: message }, { id: chrome.runtime.id, url: `${origin}/app`, frameId: 0, tab: { id: 1 } }, chrome.runtime.id, "development")).toEqual(screened);
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
  const web = signedIn(userId);
  await sync(web);
  await confirmWebAccount(userId, web.sessionCreatedAt!);
  const action = actionOf(await sync(web));
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
    expect(result).toMatchObject({ ok: false, reply: { kind: "unsupported", supported: [2] } });
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

const confirm = async (userId = U) => {
  const web = signedIn(userId);
  await sync(web);
  await confirmWebAccount(userId, web.sessionCreatedAt!);
  const action = actionOf(await sync(web));
  if (action.type !== "approve-device") throw new Error("expected confirmed device authorization");
  return action;
};

describe("explicit web account confirmation", () => {
  test("detects the account without starting an authorization or signing in", async () => {
    const web = signedIn(U);
    expect(actionOf(await sync(web))).toEqual({ type: "none", reason: "confirmation-required" });
    expect(await loadWebAccount(API)).toEqual({ userId: U, sessionCreatedAt: web.sessionCreatedAt, ...web.profile });
    expect((await buildState()).webAccount?.email).toBe(`${U}@example.com`);
    expect(server.calls).not.toContain("/api/auth/device/code");
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(await loadSession()).toBeNull();
  });

  test("offers no account without an email", async () => {
    await sync({ userId: U, sessionCreatedAt: Date.now() });
    expect(await loadWebAccount(API)).toBeNull();
    await expect(confirmWebAccount(U, Date.now())).rejects.toMatchObject({ code: "WEB_ACCOUNT_CHANGED" });
  });

  test("rejects an expired offer, another user, or another web session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const web = signedIn(U);
    await sync(web);
    await expect(confirmWebAccount(V, web.sessionCreatedAt!)).rejects.toMatchObject({ code: "WEB_ACCOUNT_CHANGED" });
    await expect(confirmWebAccount(U, web.sessionCreatedAt! + 1)).rejects.toMatchObject({ code: "WEB_ACCOUNT_CHANGED" });
    vi.setSystemTime(Date.now() + WEB_ACCOUNT_TTL_MS + 1);
    await expect(confirmWebAccount(U, web.sessionCreatedAt!)).rejects.toMatchObject({ code: "WEB_ACCOUNT_CHANGED" });
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  test("confirmation starts one code and repeated web syncs reuse it", async () => {
    const action = await confirm();
    const record = await loadPendingDeviceAuth();
    expect(record).toMatchObject({ purpose: "web-confirmed", forUserId: U });
    expect(actionOf(await sync(signedIn(U)))).toEqual(action);
    expect(server.calls.filter((path) => path === "/api/auth/device/code")).toHaveLength(1);
    expect(JSON.stringify(action)).not.toContain(record?.deviceCode);
    expect((await buildState()).pendingDeviceAuth).toMatchObject({ webAccount: true });
  });

  test("approval creates an independent session for the confirmed user", async () => {
    await link(U);
    expect(await loadSession()).toMatchObject({ token: "token-1", userId: U, source: "web" });
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "explicit-session" });
  });

  test("a token for a different user is revoked and never adopted", async () => {
    const action = await confirm();
    server.approvedUser = { id: V, email: "v@example.com" };
    server.token = "approved";
    expect(statusOf(await approved(action.requestId))).toBe("failed");
    expect(server.revoked).toEqual(["token-1"]);
    expect(await loadSession()).toBeNull();
  });

  test("pending, unknown, failed and expired approvals cannot sign in", async () => {
    const action = await confirm();
    expect(statusOf(await approved("zzzzzzzzzzzzzzzzzzzzzzzz"))).toBe("failed");
    expect(statusOf(await approved(action.requestId))).toBe("pending");
    expect(statusOf(await approved(action.requestId, "failed"))).toBe("failed");
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(actionOf(await sync(signedIn(U))).type).toBe("none");
    const again = await confirm();
    server.token = "expired";
    expect(statusOf(await approved(again.requestId))).toBe("expired");
    expect(await loadSession()).toBeNull();
  });

  test("cancel requires another explicit confirmation", async () => {
    const action = await confirm();
    await cancelDeviceSignIn();
    expect(statusOf(await approved(action.requestId))).toBe("failed");
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "confirmation-required" });
    expect(await loadPendingDeviceAuth()).toBeNull();
  });

  test("a web logout or account switch clears pending consent without starting a replacement", async () => {
    for (const next of [signedOut, signedIn(V)]) {
      const action = await confirm();
      await sync(next);
      expect(await loadPendingDeviceAuth()).toBeNull();
      expect(statusOf(await approved(action.requestId))).toBe("failed");
    }
    expect(await loadSession()).toBeNull();
  });

  test("a manual device authorization is not replaced", async () => {
    const manual: PendingDeviceAuth = {
      requestId: "manualmanualmanualmanual", deviceCode: "device-manual", userCode: "WXYZWXYZ",
      apiOrigin: API, purpose: "manual", forUserId: null, expiresAt: Date.now() + 600_000, intervalSeconds: 5,
    };
    await savePendingDeviceAuth(manual);
    const web = signedIn(U);
    await sync(web);
    await confirmWebAccount(U, web.sessionCreatedAt!);
    expect(await loadPendingDeviceAuth()).toEqual(manual);
    expect(server.calls).not.toContain("/api/auth/device/code");
  });

  test("legacy bridge requests are rejected before they can start automatic sign-in", async () => {
    const request = { ...extensionBridgeSyncRequest(API, signedIn(U)), v: 1 };
    expect(await send(request)).toMatchObject({ kind: "unsupported", supported: [2] });
    expect(await loadPendingDeviceAuth()).toBeNull();
  });
});

describe("independent sessions", () => {
  for (const source of ["web", "password", "device"] as const) {
    test(`${source} sessions survive web logout and web account switches`, async () => {
      await saveSession({ token: "mine", userId: U, email: `${U}@example.com`, source });
      await reload();
      server.mutationsFail = true;
      await enqueueOffline("entries.start", startInput("kept"), "tmp_1");
      await sync(signedOut);
      expect(await loadWebAccount(API)).toBeNull();
      await sync(signedIn(V));
      expect((await loadSession())?.token).toBe("mine");
      expect(await getOfflineQueue().size()).toBe(1);
      expect(server.revoked).toEqual([]);
      expect(await loadPendingDeviceAuth()).toBeNull();
    });
  }

  test("legacy logout markers are discarded without logging the web app out or signing the extension in", async () => {
    await chrome.storage.local.set({
      [SIGN_OUT_MARKER_STORAGE_KEY]: JSON.stringify({ userId: U, apiOrigin: API, at: Date.now() }),
      [LINK_BLOCK_STORAGE_KEY]: JSON.stringify({ apiOrigin: API, at: Date.now() }),
    });
    expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "confirmation-required" });
    expect(await chrome.storage.local.get(SIGN_OUT_MARKER_STORAGE_KEY)).toEqual({});
    expect(await chrome.storage.local.get(LINK_BLOCK_STORAGE_KEY)).toEqual({});
    expect(await loadPendingDeviceAuth()).toBeNull();
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

  test("forgets a password session while preserving its owned queued writes", async () => {
    await saveSession({ token: "pw", userId: U, email: null, source: "password" });
    await reload();
    server.mutationsFail = true;
    await enqueueOffline("entries.start", startInput("kept"), "tmp_1");
    await forgetRejectedSession();
    expect(await loadSession()).toBeNull();
    expect(await getOfflineQueue().size()).toBe(1);
    expect((await getOfflineQueue().list())[0].owner).toBe(U);
  });
});


describe("Firefox relay trust boundary", () => {
  const origin = "https://trackyourtime.dev";
  const sender = { id: "our-addon", url: `${origin}/app`, frameId: 0, tab: { id: 1 } };
  const envelope = { channel: EXTENSION_RELAY_CHANNEL, direction: "request", id: "relay-request-1234", payload: extensionBridgeSyncRequest("https://api.trackyourtime.dev", signedOut) };
  test("accepts our top-level content script without Firefox's optional sender.origin", () => {
    expect(screenRelayMessage(envelope, sender, "our-addon", "production")).toMatchObject({ ok: true, origin });
  });
  test.each([
    { id: "other-addon" }, { url: "https://evil.example/app" }, { url: "https://trackyourtime.dev.evil.example/app" },
    { url: "http://trackyourtime.dev/app" }, { url: "about:blank" }, { url: undefined },
    { origin: "https://evil.example" }, { frameId: 1 }, { frameId: undefined },
    { tab: undefined }, { tab: { incognito: true } },
  ])("refuses untrusted sender %j", (change) => {
    expect(screenRelayMessage(envelope, { ...sender, ...change }, "our-addon", "production")).toEqual({ ok: false, reply: undefined });
  });
  test("refuses raw bridge messages, popup commands, replies and malformed envelopes", () => {
    for (const message of [envelope.payload, { ...envelope, payload: { type: "SIGN_OUT" } }, { ...envelope, direction: "reply" }, { ...envelope, id: "bad" }]) {
      expect(screenRelayMessage(message, sender, "our-addon", "production")).toEqual({ ok: false, reply: undefined });
    }
  });
  test("registers only the internal relay listener on Firefox", async () => {
    const internal = vi.spyOn(chrome.runtime.onMessage, "addListener");
    const external = vi.spyOn(chrome.runtime.onMessageExternal, "addListener");
    registerBridgeListener("development", "relay");
    expect(external).not.toHaveBeenCalled();
    const listener = internal.mock.calls[0][0];
    const response = new Promise<unknown>((resolve) => {
      expect(listener({ ...envelope, payload: extensionBridgeSyncRequest(API, signedOut) }, { ...page, id: chrome.runtime.id, url: `${WEB}/app` }, resolve)).toBe(true);
    });
    expect(await response).toMatchObject({ kind: "sync-result", action: { reason: "signed-out" } });
  });
});

test("extension logout revokes only its own token and requires confirmation to sign in again", async () => {
  await link(U);
  server.sessions.set("web-token", { id: U, email: `${U}@example.com` });
  await import("./index");
  const response = await new Promise<unknown>((resolve) => {
    const event = chrome.runtime.onMessage as unknown as {
      emit: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => void;
    };
    event.emit({ type: "auth:sign-out" }, {}, resolve);
  });
  expect(response).toMatchObject({ ok: true, state: { signedIn: false } });
  expect(server.revoked).toEqual(["token-1"]);
  expect(server.sessions.has("web-token")).toBe(true);
  expect(await chrome.storage.local.get(SIGN_OUT_MARKER_STORAGE_KEY)).toEqual({});
  expect(actionOf(await sync(signedIn(U)))).toEqual({ type: "none", reason: "confirmation-required" });
  expect(await loadPendingDeviceAuth()).toBeNull();
});
