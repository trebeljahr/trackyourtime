// The web app ↔ extension bridge protocol (packages/shared has no test runner of its own).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_VERSION,
  decodeExtensionBridgeReply,
  decodeExtensionBridgeRequest,
  extensionBridgeDeviceApprovedRequest,
  extensionBridgeDeviceReply,
  extensionBridgeMatchPatterns,
  extensionBridgeSyncReply,
  extensionBridgeSyncRequest,
  extensionBridgeUnsupportedReply,
  isAllowedExtensionBridgeOrigin,
  normalizeExtensionBridgeUserCode,
} from "@starter/shared";

const API = "https://api.trackyourtime.dev";
const REQUEST_ID = "a1B2c3D4e5F6g7H8_-xy";
const SIGNED_IN = { userId: "user-1", sessionCreatedAt: 1_700_000_000_000 };

describe("extension bridge: origins", () => {
  it("production accepts exactly the hosted web app", () => {
    assert.equal(isAllowedExtensionBridgeOrigin("https://trackyourtime.dev", "production"), true);
    for (const origin of [
      "http://trackyourtime.dev",
      "https://api.trackyourtime.dev",
      "https://trackyourtime.dev.evil.com",
      "https://trackyourtime.dev/",
      "http://localhost:3392",
      "null",
      "",
      undefined,
      42,
    ]) {
      assert.equal(isAllowedExtensionBridgeOrigin(origin, "production"), false, String(origin));
    }
  });

  it("development accepts loopback on any port, over http only", () => {
    assert.equal(isAllowedExtensionBridgeOrigin("http://localhost:3392", "development"), true);
    assert.equal(isAllowedExtensionBridgeOrigin("http://127.0.0.1:51234", "development"), true);
    assert.equal(isAllowedExtensionBridgeOrigin("http://localhost", "development"), true);
    assert.equal(isAllowedExtensionBridgeOrigin("https://localhost:3392", "development"), false);
    assert.equal(isAllowedExtensionBridgeOrigin("http://localhost.evil.com", "development"), false);
    assert.equal(isAllowedExtensionBridgeOrigin("https://trackyourtime.dev", "development"), false);
  });

  it("match patterns follow the same lists", () => {
    assert.deepEqual(extensionBridgeMatchPatterns("production"), ["https://trackyourtime.dev/*"]);
    assert.deepEqual(extensionBridgeMatchPatterns("development"), [
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
  });
});

describe("extension bridge: requests", () => {
  it("round-trips what the builders write", () => {
    const sync = extensionBridgeSyncRequest(API, SIGNED_IN);
    assert.deepEqual(decodeExtensionBridgeRequest(sync), { ok: true, message: sync });

    const signedOut = extensionBridgeSyncRequest(API, { userId: null, sessionCreatedAt: null });
    assert.deepEqual(decodeExtensionBridgeRequest(signedOut), { ok: true, message: signedOut });

    const approved = extensionBridgeDeviceApprovedRequest(API, REQUEST_ID, "approved");
    assert.deepEqual(decodeExtensionBridgeRequest(approved), { ok: true, message: approved });
  });

  it("drops unknown fields and a trailing slash", () => {
    const decoded = decodeExtensionBridgeRequest({
      ...extensionBridgeSyncRequest(`${API}/`, SIGNED_IN),
      token: "leaked",
      web: { ...SIGNED_IN, email: "a@b.c" },
    });
    assert.deepEqual(decoded, { ok: true, message: extensionBridgeSyncRequest(API, SIGNED_IN) });
  });

  it("tells a foreign message from an unreadable version from a malformed one", () => {
    assert.deepEqual(decodeExtensionBridgeRequest(null), { ok: false, problem: "not-bridge" });
    assert.deepEqual(decodeExtensionBridgeRequest("sync"), { ok: false, problem: "not-bridge" });
    assert.deepEqual(decodeExtensionBridgeRequest({ kind: "sync" }), {
      ok: false,
      problem: "not-bridge",
    });
    assert.deepEqual(
      decodeExtensionBridgeRequest({ ...extensionBridgeSyncRequest(API, SIGNED_IN), v: 2 }),
      { ok: false, problem: "unsupported-version" },
    );
    assert.deepEqual(
      decodeExtensionBridgeRequest({ ...extensionBridgeSyncRequest(API, SIGNED_IN), kind: "steal" }),
      { ok: false, problem: "malformed" },
    );
  });

  it("refuses an api origin that is not a bare http(s) origin", () => {
    for (const apiOrigin of [
      "javascript:alert(1)",
      "chrome-extension://abc",
      "https://api.trackyourtime.dev/api",
      "https://user:pw@api.trackyourtime.dev",
      "https://api.trackyourtime.dev?x=1",
      "not a url",
      "",
      `https://${"a".repeat(3000)}.dev`,
    ]) {
      const decoded = decodeExtensionBridgeRequest({
        ...extensionBridgeSyncRequest(API, SIGNED_IN),
        apiOrigin,
      });
      assert.equal(decoded.ok, false, apiOrigin);
    }
  });

  it("requires a consistent web session", () => {
    const base = extensionBridgeSyncRequest(API, SIGNED_IN);
    for (const web of [
      { userId: null, sessionCreatedAt: 5 },
      { userId: "user-1", sessionCreatedAt: null },
      { userId: "", sessionCreatedAt: 5 },
      { userId: "user\n1", sessionCreatedAt: 5 },
      { userId: "x".repeat(129), sessionCreatedAt: 5 },
      { userId: "user-1", sessionCreatedAt: Number.NaN },
      { userId: "user-1", sessionCreatedAt: -1 },
      { userId: 7, sessionCreatedAt: 5 },
      undefined,
    ]) {
      assert.deepEqual(decodeExtensionBridgeRequest({ ...base, web }), {
        ok: false,
        problem: "malformed",
      });
    }
  });

  it("requires a well-formed request id and outcome", () => {
    const base = extensionBridgeDeviceApprovedRequest(API, REQUEST_ID, "failed");
    for (const patch of [
      { requestId: "short" },
      { requestId: `${REQUEST_ID}!` },
      { requestId: undefined },
      { outcome: "maybe" },
    ]) {
      assert.equal(decodeExtensionBridgeRequest({ ...base, ...patch }).ok, false);
    }
  });
});

describe("extension bridge: replies", () => {
  it("round-trips every action and status", () => {
    const replies = [
      extensionBridgeSyncReply({ type: "none", reason: "other-server" }),
      extensionBridgeSyncReply({
        type: "approve-device",
        requestId: REQUEST_ID,
        userCode: "ABCD2345",
        expiresAt: 1_700_000_600_000,
      }),
      extensionBridgeSyncReply({ type: "sign-out-web", at: 1_700_000_100_000 }),
      extensionBridgeDeviceReply("signed-in"),
      extensionBridgeDeviceReply("expired"),
    ];
    for (const reply of replies) {
      assert.deepEqual(decodeExtensionBridgeReply(reply), { ok: true, message: reply });
    }
  });

  it("reads an unsupported reply at any version", () => {
    const decoded = decodeExtensionBridgeReply({
      ...extensionBridgeUnsupportedReply(),
      v: 9,
      supported: [9, "1", 8.5],
    });
    assert.deepEqual(decoded, {
      ok: true,
      message: { channel: EXTENSION_BRIDGE_CHANNEL, v: 9, kind: "unsupported", supported: [9] },
    });
  });

  it("treats no answer as no extension", () => {
    assert.deepEqual(decodeExtensionBridgeReply(undefined), { ok: false, problem: "not-bridge" });
  });

  it("refuses unknown actions, reasons and statuses", () => {
    const envelope = { channel: EXTENSION_BRIDGE_CHANNEL, v: EXTENSION_BRIDGE_VERSION };
    for (const reply of [
      { ...envelope, kind: "sync-result", action: { type: "none", reason: "because" } },
      { ...envelope, kind: "sync-result", action: { type: "navigate", url: "https://evil" } },
      { ...envelope, kind: "sync-result", action: { type: "sign-out-web" } },
      {
        ...envelope,
        kind: "sync-result",
        action: { type: "approve-device", requestId: REQUEST_ID, userCode: "<b>", expiresAt: 1 },
      },
      { ...envelope, kind: "device-result", status: "done" },
      { ...envelope, kind: "token", token: "x" },
    ]) {
      assert.deepEqual(decodeExtensionBridgeReply(reply), { ok: false, problem: "malformed" });
    }
  });

  it("normalises a user code the way /device/approve wants it", () => {
    assert.equal(normalizeExtensionBridgeUserCode("abcd-2345"), "ABCD2345");
    assert.equal(normalizeExtensionBridgeUserCode("ABC"), null);
    assert.equal(normalizeExtensionBridgeUserCode("ABCD 2345"), null);
    assert.equal(normalizeExtensionBridgeUserCode("A".repeat(33)), null);
    assert.equal(normalizeExtensionBridgeUserCode(12345678), null);
  });
});
