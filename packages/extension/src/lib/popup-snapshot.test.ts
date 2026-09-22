import { describe, expect, test } from "vitest";
import type { BackgroundState } from "./messaging";
import { sessionStorageArea } from "./chrome-storage";
import {
  loadPopupSnapshot,
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
