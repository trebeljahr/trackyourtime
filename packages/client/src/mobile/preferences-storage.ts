/*
 * `KeyValueStorage` over `@capacitor/preferences`, for the data the native
 * shell cannot afford to lose.
 *
 * WKWebView classifies `localStorage` as *non-critical web data*: iOS evicts
 * it after low storage, and after roughly seven days of app inactivity. The
 * offline queue holds tracked time that has never reached a server, so an
 * eviction there is not a cache miss — it is a day of the user's work, gone,
 * with no error anywhere. `webStorage()` swallows every throw
 * (`packages/core/src/storage.ts`), so it would not even be loud about it.
 *
 * Preferences is `UserDefaults` / `SharedPreferences`: app-container data the
 * OS keeps until the app is deleted. It is deliberately NOT where the session
 * token lives — that is the Keychain, see `lib/native-session.ts`. Data here,
 * credentials there.
 *
 * The plugin is loaded lazily so the web bundle never pulls a Capacitor
 * package in, and the whole module is inert unless `isCapacitor()`.
 */

import {
  type KeyValueStorage,
  OFFLINE_QUEUE_OWNER_STORAGE_KEY,
  OFFLINE_QUEUE_STORAGE_KEY,
  webStorage,
} from "@starter/core";

import { isCapacitor } from "@/lib/shell";

/**
 * The single marker builds up to 2026-09-15 wrote, once for every store at
 * once. Whichever store initialised first claimed it, so the other one never
 * migrated: a device that had already run the queue hand-over skipped the
 * workspace keys, and one upgrading from a pre-Preferences build could skip
 * the queue if the workspace store came first.
 *
 * It is still read, and only for the keys it was introduced for. For those it
 * means "probably handed over already", which is not the same as "handed
 * over": it cannot say which store wrote it. So a legacy-covered key still
 * adopts a localStorage copy when Preferences holds nothing under that key —
 * rows that can only be stranded ones — but never removes a localStorage copy
 * it did not adopt. Keys added later (the workspace keys) ignore it entirely.
 */
const LEGACY_MIGRATION_MARKER_KEY = "trackyourtime.preferences-migrated";
const LEGACY_MARKER_COVERS: ReadonlySet<string> = new Set([
  OFFLINE_QUEUE_STORAGE_KEY,
  OFFLINE_QUEUE_OWNER_STORAGE_KEY,
]);

/**
 * Written into Preferences once a key's localStorage hand-over below has run —
 * one marker PER KEY, because several stores migrate different keys and each
 * must run its own hand-over whichever of them initialises first. Preferences
 * is wiped on delete, so a reinstall re-runs a migration that has nothing left
 * to find — which is harmless and correct.
 */
export const migrationMarkerKey = (key: string): string =>
  `${LEGACY_MIGRATION_MARKER_KEY}:${key}`;

/** The plugin surface this module uses, so nothing here holds the Proxy. */
type PreferencesPlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

let pluginPromise: Promise<PreferencesPlugin | null> | null = null;

const loadPreferences = (): Promise<PreferencesPlugin | null> => {
  pluginPromise ??= (async () => {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      /*
       * Wrapped in a plain object, never returned as-is. A Capacitor plugin
       * handle is a Proxy that answers every property with a callable — `then`
       * included — so returning it from an `async` function makes the promise
       * machinery adopt it as a thenable and dispatch a bridge call for a
       * native method named "then" that nothing implements. Nothing resolves,
       * ever. See the same note in `lib/native-session.ts`; it cost an
       * afternoon once already.
       */
      return {
        get: (options: { key: string }) => Preferences.get(options),
        set: (options: { key: string; value: string }) =>
          Preferences.set(options),
        remove: (options: { key: string }) => Preferences.remove(options),
      };
    } catch {
      // A build that dropped the plugin must degrade, not crash: the SPM sync
      // silently skips a plugin with no Package.swift, and the queue still
      // works over localStorage — just without the durability guarantee.
      return null;
    }
  })();
  return pluginPromise;
};

/**
 * Move keys that used to live in `localStorage` across, once.
 *
 * Without this, shipping the Preferences-backed queue is itself a data-loss
 * event: whatever a previous build queued sits in WKWebView's localStorage
 * under the same key, where nothing will ever read it again. The rows are not
 * corrupted or stale — they are simply orphaned by the change of address.
 *
 * `remove` on the localStorage copy is deliberate. Leaving it would let a
 * rollback to an older build replay mutations that this build has already
 * flushed, i.e. duplicate the user's entries.
 */
const migrateFromLocalStorage = async (
  plugin: PreferencesPlugin,
  keys: readonly string[],
): Promise<void> => {
  let legacyMarker: Promise<boolean> | null = null;
  const legacyMarkerPresent = (): Promise<boolean> => {
    legacyMarker ??= plugin
      .get({ key: LEGACY_MIGRATION_MARKER_KEY })
      .then(({ value }) => Boolean(value));
    return legacyMarker;
  };

  for (const key of keys) {
    const markerKey = migrationMarkerKey(key);
    const marker = await plugin.get({ key: markerKey });
    if (marker.value) continue;

    const coveredByLegacy =
      LEGACY_MARKER_COVERS.has(key) && (await legacyMarkerPresent());

    let local: string | null = null;
    try {
      local = window.localStorage.getItem(key);
    } catch {
      local = null;
    }

    if (local !== null && local !== "") {
      // Never overwrite: if this build has already written something here, the
      // Preferences copy is the newer one and localStorage is the leftover.
      const existing = await plugin.get({ key });
      const adopt = existing.value === null || existing.value === undefined;
      if (adopt) await plugin.set({ key, value: local });

      // Under the legacy marker a copy that was not adopted may be rows the
      // old marker stranded, not a leftover — keep it rather than delete it.
      if (adopt || !coveredByLegacy) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* storage denied — the copy across already happened, which is the
             half that matters */
        }
      }
    }

    // Per key and after the key's own work, so a throw part-way leaves the
    // remaining keys to the next launch rather than claiming them.
    await plugin.set({ key: markerKey, value: "1" });
  }
};

export type PreferencesStorageOptions = {
  /** Keys to hand over from `localStorage` on first use. */
  migrateKeys?: readonly string[];
  /** Test seam. */
  loadPlugin?: () => Promise<PreferencesPlugin | null>;
};

/**
 * A Preferences-backed store. Every method waits on the same one-time
 * initialisation, so the migration can never interleave with a write.
 *
 * When the plugin is unavailable the store falls back to `localStorage`, which
 * is what the app used before — worse, but working.
 */
export const preferencesStorage = ({
  migrateKeys = [],
  loadPlugin = loadPreferences,
}: PreferencesStorageOptions = {}): KeyValueStorage => {
  const fallback = webStorage(
    typeof window === "undefined"
      ? { getItem: () => null, setItem: () => {}, removeItem: () => {} }
      : window.localStorage,
  );

  let ready: Promise<PreferencesPlugin | null> | null = null;

  const ensure = (): Promise<PreferencesPlugin | null> => {
    ready ??= (async () => {
      const plugin = await loadPlugin();
      if (plugin === null) return null;
      try {
        await migrateFromLocalStorage(plugin, migrateKeys);
      } catch {
        // A failed migration must not take the queue down with it. The rows
        // stay in localStorage; the marker is not written, so the next launch
        // tries again.
      }
      return plugin;
    })();
    return ready;
  };

  return {
    getItem: async (key) => {
      const plugin = await ensure();
      if (plugin === null) return fallback.getItem(key);
      try {
        const { value } = await plugin.get({ key });
        return value ?? null;
      } catch {
        return null;
      }
    },
    setItem: async (key, value) => {
      const plugin = await ensure();
      if (plugin === null) return fallback.setItem(key, value);
      try {
        await plugin.set({ key, value });
      } catch {
        /* nothing useful to do at the call site — the caller is a queue write */
      }
    },
    removeItem: async (key) => {
      const plugin = await ensure();
      if (plugin === null) return fallback.removeItem(key);
      try {
        await plugin.remove({ key });
      } catch {
        /* ignore */
      }
    },
  };
};

/**
 * True when Preferences-backed storage should be used at all.
 *
 * `isCapacitor()` is a synchronous read of `window.Capacitor`, which the native
 * bridge injects at document start — before any application code runs. That
 * matters because `getOfflineQueue()` memoises its storage on the first call:
 * the branch has to be right the first time, and an async probe would not be.
 */
export const shouldUseNativeStorage = (): boolean => isCapacitor();
