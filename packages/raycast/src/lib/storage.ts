/**
 * Raycast's encrypted per-extension store, in the shape `@starter/core`
 * expects, so the shared timer echo and anything else built on
 * `KeyValueStorage` works here without a Raycast-specific copy.
 */
import { LocalStorage } from "@raycast/api";
import { readTimerEcho, writeTimerEcho, type KeyValueStorage, type TimerEcho } from "../vendor/index.js";

export const raycastStorage: KeyValueStorage = {
  getItem: async (key) => (await LocalStorage.getItem<string>(key)) ?? null,
  setItem: (key, value) => LocalStorage.setItem(key, value),
  removeItem: (key) => LocalStorage.removeItem(key),
};

/**
 * What this Mac last did to the timer.
 *
 * Every Raycast command is its own short-lived process, so there is no
 * in-memory state for them to share — the menu bar cannot be told anything by
 * the Timer command except through storage. This is that channel, and it is
 * what stops the menu bar from ticking a timer the user stopped a second ago
 * from somewhere else in Raycast.
 */
export const noteTimerEcho = (runningId: string | null): Promise<void> => writeTimerEcho(raycastStorage, runningId);

export const loadTimerEcho = (): Promise<TimerEcho | null> => readTimerEcho(raycastStorage);
