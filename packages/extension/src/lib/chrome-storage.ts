/**
 * `chrome.storage` as a @starter/core {@link KeyValueStorage}, so the offline
 * queue and everything else in core works unchanged inside the extension.
 *
 * Two areas, deliberately different:
 *  - `chrome.storage.session` is memory-only and dies with the browser. The
 *    session token lives there so it never touches disk.
 *  - `chrome.storage.local` persists. The API URL and the offline queue live
 *    there because losing them on restart would be worse than useless.
 */
import type { KeyValueStorage } from "@starter/core";

/**
 * Resolve a storage area without assuming we are inside an extension page.
 * A popup unit test, or a background module imported by a build script, has
 * no `chrome` global at all — returning null there lets the caller degrade
 * instead of throwing at module load.
 */
const resolveArea = (
  name: "session" | "local",
): chrome.storage.StorageArea | null => {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  return api?.storage?.[name] ?? null;
};

export const sessionStorageArea = (): chrome.storage.StorageArea | null =>
  resolveArea("session");

export const localStorageArea = (): chrome.storage.StorageArea | null =>
  resolveArea("local");

/** Strict stores must acknowledge persistence before a write reaches HTTP. */
export const chromeStorage = (
  area: chrome.storage.StorageArea | null,
  { strict = false }: { strict?: boolean } = {},
): KeyValueStorage => ({
  getItem: async (key) => {
    if (!area) {
      if (strict) throw new Error("Persistent extension storage is unavailable");
      return null;
    }
    try {
      const record: Record<string, unknown> = await area.get(key);
      const value = record[key];
      return typeof value === "string" ? value : null;
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  },
  setItem: async (key, value) => {
    if (!area) {
      if (strict) throw new Error("Persistent extension storage is unavailable");
      return;
    }
    try {
      await area.set({ [key]: value });
    } catch (error) {
      if (strict) throw error;
    }
  },
  removeItem: async (key) => {
    if (!area) {
      if (strict) throw new Error("Persistent extension storage is unavailable");
      return;
    }
    try {
      await area.remove(key);
    } catch (error) {
      if (strict) throw error;
    }
  },
});
