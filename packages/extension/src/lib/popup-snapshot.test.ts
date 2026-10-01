import { afterEach, describe, expect, test, vi } from "vitest";
import type { BackgroundState } from "./messaging";
import { sessionStorageArea } from "./chrome-storage";
import {
  loadPopupSnapshot,
  mergePopupSnapshot,
  POPUP_SNAPSHOT_KEY,
  savePopupSnapshot,
} from "./popup-snapshot";

const state = { signedIn: true, apiUrl: "https://api.example.test" } as BackgroundState;

describe("popup snapshot", () => {
  test("round-trips the last answer through session storage", async () => {
    await savePopupSnapshot(state);
    expect(await loadPopupSnapshot()).toEqual(state);
  });

  test("the next answer replaces it, so a sign-out leaves no signed-in copy", async () => {
    await savePopupSnapshot(state);
    await savePopupSnapshot({ ...state, signedIn: false });
    expect((await loadPopupSnapshot())?.signedIn).toBe(false);
  });

  test("ignores a copy written in another shape", async () => {
    await sessionStorageArea()?.set({ [POPUP_SNAPSHOT_KEY]: { v: 999, state } });
    expect(await loadPopupSnapshot()).toBeNull();
    await sessionStorageArea()?.set({ [POPUP_SNAPSHOT_KEY]: "garbage" });
    expect(await loadPopupSnapshot()).toBeNull();
  });
});


describe("stalled snapshot storage", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  test("lets startup proceed without a cache after 250ms", async () => {
    vi.useFakeTimers();
    vi.spyOn(chrome.storage.session, "get").mockImplementation(() => new Promise(() => {}));
    const pending = loadPopupSnapshot();
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cached entry pages", () => {
  const page = { entries: [], from: "2026-10-01", to: "2026-10-02", hasMore: false, pendingIds: [] };
  const scoped = {
    ...state,
    settings: { userId: "u1" },
    activeWorkspaceId: "w1",
    entries: page,
    entriesStale: false,
  } as unknown as BackgroundState;

  test("retains entries through tracker snapshots and popup reopen", async () => {
    await savePopupSnapshot(scoped);
    await savePopupSnapshot({ ...scoped, entries: null });
    expect(await loadPopupSnapshot()).toMatchObject({ entries: page, entriesStale: true });
  });

  test("keeps the visible page until refresh replaces it, including an empty result", () => {
    const cached = { ...scoped, entries: { ...page, hasMore: true } };
    expect(mergePopupSnapshot(cached, { ...scoped, entries: null }).entries).toBe(cached.entries);
    expect(mergePopupSnapshot(cached, scoped)).toBe(scoped);
  });

  test.each([
    { signedIn: false },
    { apiUrl: "https://other.example.test" },
    { settings: { userId: "u2" } },
    { settings: null },
    { activeWorkspaceId: "w2" },
    { activeWorkspaceId: null },
  ])("drops cached rows when scope changes: %j", (change) => {
    const next = { ...scoped, entries: null, ...change } as BackgroundState;
    expect(mergePopupSnapshot(scoped, next).entries).toBeNull();
  });

  test("ordered writes cannot restore entries after sign-out", async () => {
    await Promise.all([
      savePopupSnapshot(scoped),
      savePopupSnapshot({ ...scoped, entries: null }),
      savePopupSnapshot({ ...scoped, signedIn: false, entries: null }),
    ]);
    expect(await loadPopupSnapshot()).toMatchObject({ signedIn: false, entries: null });
  });
});
