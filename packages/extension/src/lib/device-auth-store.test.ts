import { describe, expect, test } from "vitest";
import {
  clearPendingDeviceAuth,
  createDeviceRequestId,
  decodePendingDeviceAuth,
  isLivePendingDeviceAuth,
  loadDeviceSignInError,
  loadPendingDeviceAuth,
  PENDING_DEVICE_AUTH_KEY,
  saveDeviceSignInError,
  savePendingDeviceAuth,
  type PendingDeviceAuth,
} from "./device-auth-store";

const API = "http://localhost:5159";

const record: PendingDeviceAuth = {
  requestId: "abcdefghijklmnopqrstuvwx",
  deviceCode: "device-code",
  userCode: "ABCDEFGH",
  apiOrigin: API,
  purpose: "web-link",
  forUserId: "u1",
  expiresAt: 2_000,
  intervalSeconds: 5,
};

describe("the pending device authorization", () => {
  test("lives in session storage and is read back", async () => {
    await savePendingDeviceAuth(record);
    expect(await chrome.storage.session.get(PENDING_DEVICE_AUTH_KEY)).toHaveProperty(
      PENDING_DEVICE_AUTH_KEY,
    );
    expect(await chrome.storage.local.get(PENDING_DEVICE_AUTH_KEY)).toEqual({});
    expect(await loadPendingDeviceAuth()).toEqual(record);
    await clearPendingDeviceAuth();
    expect(await loadPendingDeviceAuth()).toBeNull();
  });

  test("a malformed record is none", () => {
    expect(decodePendingDeviceAuth("{")).toBeNull();
    expect(decodePendingDeviceAuth(JSON.stringify({ ...record, deviceCode: "" }))).toBeNull();
    expect(decodePendingDeviceAuth(JSON.stringify({ ...record, purpose: "other" }))).toBeNull();
    expect(decodePendingDeviceAuth(JSON.stringify({ ...record, expiresAt: "soon" }))).toBeNull();
  });

  test("a web-link record without its user is none; a manual one never carries one", () => {
    expect(decodePendingDeviceAuth(JSON.stringify({ ...record, forUserId: null }))).toBeNull();
    expect(
      decodePendingDeviceAuth(JSON.stringify({ ...record, purpose: "manual", forUserId: "u1" }))
        ?.forUserId,
    ).toBeNull();
  });

  test("is live only before it expires and only for its own server", () => {
    expect(isLivePendingDeviceAuth(record, API, 1_000)).toBe(true);
    expect(isLivePendingDeviceAuth(record, API, 2_000)).toBe(false);
    expect(isLivePendingDeviceAuth(record, "https://track.example.com", 1_000)).toBe(false);
  });

  test("request ids are 24 url-safe characters and differ", () => {
    const a = createDeviceRequestId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(createDeviceRequestId()).not.toBe(a);
  });

  test("the popup's last error survives a read and ignores junk", async () => {
    await saveDeviceSignInError("expired");
    expect(await loadDeviceSignInError()).toBe("expired");
  });
});
