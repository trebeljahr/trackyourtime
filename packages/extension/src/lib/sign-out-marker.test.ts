import { EXTENSION_SIGN_OUT_MARKER_TTL_MS } from "@starter/shared/extension-bridge";
import { describe, expect, test } from "vitest";
import {
  clearLinkBlock,
  clearSignOutMarker,
  decodeLinkBlock,
  isLinkBlocked,
  loadLinkBlock,
  saveLinkBlock,
  decodeSignOutMarker,
  loadSignOutMarker,
  saveSignOutMarker,
  signOutMarkerVerdict,
  SIGN_OUT_MARKER_STORAGE_KEY,
  type SignOutMarker,
} from "./sign-out-marker";

const API = "https://api.trackyourtime.dev";
const NOW = 1_800_000_000_000;
const marker: SignOutMarker = { userId: "u1", apiOrigin: API, at: NOW - 1000 };

describe("the sign-out marker", () => {
  test("is kept in local storage and read back", async () => {
    await saveSignOutMarker(marker);
    expect(await loadSignOutMarker()).toEqual(marker);
    expect(chrome.storage.local).toBeDefined();
    await clearSignOutMarker();
    expect(await loadSignOutMarker()).toBeNull();
  });

  test("anything that is not a marker decodes as none", async () => {
    expect(decodeSignOutMarker("{oops")).toBeNull();
    expect(decodeSignOutMarker(JSON.stringify({ userId: "", apiOrigin: API, at: 1 }))).toBeNull();
    expect(decodeSignOutMarker(JSON.stringify({ userId: "u", apiOrigin: API, at: "1" }))).toBeNull();
    await chrome.storage.local.set({ [SIGN_OUT_MARKER_STORAGE_KEY]: 42 });
    expect(await loadSignOutMarker()).toBeNull();
  });
});

describe("signOutMarkerVerdict", () => {
  const web = { userId: "u1", sessionCreatedAt: NOW - 60_000 };

  test("signs out the same person's older web session on the same server", () => {
    expect(signOutMarkerVerdict(marker, API, web, NOW)).toBe("sign-out-web");
  });

  test("a web session newer than the sign-out is left alone", () => {
    expect(
      signOutMarkerVerdict(marker, API, { userId: "u1", sessionCreatedAt: NOW }, NOW),
    ).toBe("discard");
  });

  test("never signs out a different account", () => {
    expect(
      signOutMarkerVerdict(marker, API, { userId: "u2", sessionCreatedAt: NOW - 60_000 }, NOW),
    ).toBe("discard");
  });

  test("never applies to another server", () => {
    expect(signOutMarkerVerdict(marker, "https://track.example.com", web, NOW)).toBe("discard");
  });

  test("expires", () => {
    const old = { ...marker, at: NOW - EXTENSION_SIGN_OUT_MARKER_TTL_MS - 1 };
    expect(
      signOutMarkerVerdict(old, API, { userId: "u1", sessionCreatedAt: old.at - 1 }, NOW),
    ).toBe("discard");
  });

  test("a signed-out page discards it", () => {
    expect(
      signOutMarkerVerdict(marker, API, { userId: null, sessionCreatedAt: null }, NOW),
    ).toBe("discard");
  });
});

describe("the link block", () => {
  test("is kept in local storage, read back and cleared", async () => {
    await saveLinkBlock({ apiOrigin: API, at: NOW });
    expect(await loadLinkBlock()).toEqual({ apiOrigin: API, at: NOW });
    await clearLinkBlock();
    expect(await loadLinkBlock()).toBeNull();
    expect(decodeLinkBlock("{oops")).toBeNull();
    expect(decodeLinkBlock(JSON.stringify({ apiOrigin: API, at: -1 }))).toBeNull();
  });

  test("blocks sessions that began at or before it, on its server only", () => {
    const block = { apiOrigin: API, at: NOW };
    expect(isLinkBlocked(block, API, NOW - 1)).toBe(true);
    expect(isLinkBlocked(block, API, NOW)).toBe(true);
    expect(isLinkBlocked(block, API, null)).toBe(true);
    expect(isLinkBlocked(block, API, NOW + 1)).toBe(false);
    expect(isLinkBlocked(block, "https://track.example.com", NOW - 1)).toBe(false);
    expect(isLinkBlocked(null, API, NOW - 1)).toBe(false);
  });
});
