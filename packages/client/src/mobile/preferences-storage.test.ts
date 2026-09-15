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

import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  OFFLINE_QUEUE_OWNER_STORAGE_KEY,
  OFFLINE_QUEUE_STORAGE_KEY,
} from "@starter/core";

import {
  migrationMarkerKey,
  preferencesStorage,
} from "@/mobile/preferences-storage";

const QUEUE_KEY = OFFLINE_QUEUE_STORAGE_KEY;
const OWNER_KEY = OFFLINE_QUEUE_OWNER_STORAGE_KEY;
const WORKSPACE_KEY = ACTIVE_WORKSPACE_STORAGE_KEY;
const KNOWN_KEY = "trackyourtime.known-workspaces";
/** The one global marker builds before per-key markers wrote. */
const LEGACY_MARKER_KEY = "trackyourtime.preferences-migrated";
const MARKER_KEY = migrationMarkerKey(QUEUE_KEY);

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

  describe("with several stores migrating different keys", () => {
    const queueStore = (plugin: ReturnType<typeof fakePlugin>) =>
      preferencesStorage({
        migrateKeys: [QUEUE_KEY, OWNER_KEY],
        loadPlugin: async () => plugin,
      });
    const workspaceStore = (plugin: ReturnType<typeof fakePlugin>) =>
      preferencesStorage({
        migrateKeys: [WORKSPACE_KEY, KNOWN_KEY],
        loadPlugin: async () => plugin,
      });

    const seedLocal = () => {
      window.localStorage.setItem(QUEUE_KEY, "queue");
      window.localStorage.setItem(OWNER_KEY, "owner");
      window.localStorage.setItem(WORKSPACE_KEY, "ws-1");
      window.localStorage.setItem(KNOWN_KEY, "known");
    };

    it.each([
      ["queue first", ["queue", "workspace"]],
      ["workspace first", ["workspace", "queue"]],
    ] as const)("migrates both, %s", async (_label, order) => {
      seedLocal();
      const plugin = fakePlugin();
      const stores = {
        queue: queueStore(plugin),
        workspace: workspaceStore(plugin),
      };

      for (const name of order) await stores[name].getItem("anything");

      expect(await stores.queue.getItem(QUEUE_KEY)).toBe("queue");
      expect(await stores.queue.getItem(OWNER_KEY)).toBe("owner");
      expect(await stores.workspace.getItem(WORKSPACE_KEY)).toBe("ws-1");
      expect(await stores.workspace.getItem(KNOWN_KEY)).toBe("known");
      for (const key of [QUEUE_KEY, OWNER_KEY, WORKSPACE_KEY, KNOWN_KEY]) {
        expect(window.localStorage.getItem(key)).toBeNull();
        expect(plugin.store.get(migrationMarkerKey(key))).toBe("1");
      }
    });

    it("migrates both when their first calls race", async () => {
      seedLocal();
      const plugin = fakePlugin();
      const queue = queueStore(plugin);
      const workspace = workspaceStore(plugin);

      const [queued, active] = await Promise.all([
        queue.getItem(QUEUE_KEY),
        workspace.getItem(WORKSPACE_KEY),
      ]);
      expect(queued).toBe("queue");
      expect(active).toBe("ws-1");
    });

    it("still migrates the workspace keys on a device with the old global marker", async () => {
      // The queue hand-over already ran under the old marker: its localStorage
      // copy is gone and Preferences holds the live queue.
      window.localStorage.setItem(WORKSPACE_KEY, "ws-1");
      window.localStorage.setItem(KNOWN_KEY, "known");
      const plugin = fakePlugin({
        [LEGACY_MARKER_KEY]: "1",
        [QUEUE_KEY]: "live-queue",
      });

      const workspace = workspaceStore(plugin);
      expect(await workspace.getItem(WORKSPACE_KEY)).toBe("ws-1");
      expect(await workspace.getItem(KNOWN_KEY)).toBe("known");
      expect(window.localStorage.getItem(WORKSPACE_KEY)).toBeNull();
      expect(window.localStorage.getItem(KNOWN_KEY)).toBeNull();

      const queue = queueStore(plugin);
      expect(await queue.getItem(QUEUE_KEY)).toBe("live-queue");
    });

    it("does not let the old global marker's queue copy clobber or delete anything", async () => {
      // Under the old marker Preferences already holds the queue. Something is
      // in localStorage under the same key too; it is neither written over the
      // live queue nor deleted, since the old marker cannot say whether it is
      // a leftover or rows it stranded.
      window.localStorage.setItem(QUEUE_KEY, "local-rows");
      const plugin = fakePlugin({
        [LEGACY_MARKER_KEY]: "1",
        [QUEUE_KEY]: "live-queue",
      });

      const queue = queueStore(plugin);
      expect(await queue.getItem(QUEUE_KEY)).toBe("live-queue");
      expect(window.localStorage.getItem(QUEUE_KEY)).toBe("local-rows");
      expect(plugin.store.get(MARKER_KEY)).toBe("1");
    });

    it("adopts queue rows the old global marker stranded when Preferences has none", async () => {
      // The workspace store initialised first on an upgrade from a
      // pre-Preferences build and claimed the old marker for everyone.
      window.localStorage.setItem(QUEUE_KEY, "stranded");
      const plugin = fakePlugin({ [LEGACY_MARKER_KEY]: "1" });

      const queue = queueStore(plugin);
      expect(await queue.getItem(QUEUE_KEY)).toBe("stranded");
      expect(window.localStorage.getItem(QUEUE_KEY)).toBeNull();
    });

    it("never overwrites a workspace value the native store already holds", async () => {
      window.localStorage.setItem(WORKSPACE_KEY, "stale");
      const plugin = fakePlugin({
        [LEGACY_MARKER_KEY]: "1",
        [WORKSPACE_KEY]: "live",
      });

      const workspace = workspaceStore(plugin);
      expect(await workspace.getItem(WORKSPACE_KEY)).toBe("live");
      expect(window.localStorage.getItem(WORKSPACE_KEY)).toBeNull();
    });
  });
});
