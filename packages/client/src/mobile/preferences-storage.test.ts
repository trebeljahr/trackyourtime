// @vitest-environment jsdom
/**
 * The Preferences-backed store, and the one-time hand-over that makes
 * switching to it safe.
 *
 * The migration is the part worth pinning: without it, shipping this change
 * is itself a data-loss event. Everything a previous build queued sits in
 * WKWebView's `localStorage` under the same key, and the new store reads a
 * different address — so the rows are not stale or corrupt, they are simply
 * never looked at again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { preferencesStorage } from "@/mobile/preferences-storage";

const QUEUE_KEY = "trackyourtime.offline-queue";
const MARKER_KEY = "trackyourtime.preferences-migrated";

/** A fake @capacitor/preferences: the three calls, over a Map. */
const fakePlugin = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: store.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
  };
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("preferencesStorage", () => {
  it("reads and writes through the plugin, not localStorage", async () => {
    const plugin = fakePlugin();
    const storage = preferencesStorage({ loadPlugin: async () => plugin });

    await storage.setItem("k", "v");
    expect(await storage.getItem("k")).toBe("v");
    expect(plugin.store.get("k")).toBe("v");
    expect(window.localStorage.getItem("k")).toBeNull();

    await storage.removeItem("k");
    expect(await storage.getItem("k")).toBeNull();
  });

  it("hands a queue left in localStorage over on first use", async () => {
    window.localStorage.setItem(QUEUE_KEY, '[{"id":"q1","op":"entries.start"}]');
    const plugin = fakePlugin();
    const storage = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });

    expect(await storage.getItem(QUEUE_KEY)).toBe(
      '[{"id":"q1","op":"entries.start"}]',
    );
    // Removed from the old address: leaving it would let a rollback to the
    // previous build replay mutations this one has already flushed.
    expect(window.localStorage.getItem(QUEUE_KEY)).toBeNull();
    expect(plugin.store.get(MARKER_KEY)).toBe("1");
  });

  it("runs the migration once, even across store instances", async () => {
    window.localStorage.setItem(QUEUE_KEY, "first");
    const plugin = fakePlugin();

    const first = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });
    await first.getItem(QUEUE_KEY);

    // A later build writes something new into localStorage under the same
    // key (or an old tab does). The marker means it is not picked up again.
    window.localStorage.setItem(QUEUE_KEY, "second");
    const second = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });
    expect(await second.getItem(QUEUE_KEY)).toBe("first");
    expect(window.localStorage.getItem(QUEUE_KEY)).toBe("second");
  });

  it("never overwrites a value the native store already holds", async () => {
    window.localStorage.setItem(QUEUE_KEY, "stale");
    const plugin = fakePlugin({ [QUEUE_KEY]: "live" });
    const storage = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });

    expect(await storage.getItem(QUEUE_KEY)).toBe("live");
    expect(window.localStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it("serialises every call behind one initialisation", async () => {
    window.localStorage.setItem(QUEUE_KEY, "queued");
    const plugin = fakePlugin();
    const storage = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });

    // A write racing the very first read must not land before the migration
    // and then be clobbered by it.
    const [, read] = await Promise.all([
      storage.setItem("other", "x"),
      storage.getItem(QUEUE_KEY),
    ]);
    expect(read).toBe("queued");
    expect(plugin.store.get("other")).toBe("x");
  });

  it("falls back to localStorage when the plugin is missing", async () => {
    const storage = preferencesStorage({ loadPlugin: async () => null });

    await storage.setItem("k", "v");
    expect(window.localStorage.getItem("k")).toBe("v");
    expect(await storage.getItem("k")).toBe("v");
  });

  it("keeps the rows and retries when the migration throws", async () => {
    window.localStorage.setItem(QUEUE_KEY, "queued");
    const plugin = fakePlugin();
    plugin.get.mockRejectedValueOnce(new Error("plugin exploded"));

    const storage = preferencesStorage({
      migrateKeys: [QUEUE_KEY],
      loadPlugin: async () => plugin,
    });

    // The read itself degrades to "nothing there" rather than throwing on the
    // launch path…
    expect(await storage.getItem(QUEUE_KEY)).toBeNull();
    // …and the rows are still where they were, with no marker claiming the
    // hand-over happened.
    expect(window.localStorage.getItem(QUEUE_KEY)).toBe("queued");
    expect(plugin.store.get(MARKER_KEY)).toBeUndefined();
  });
});
