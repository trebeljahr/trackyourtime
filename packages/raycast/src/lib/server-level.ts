/**
 * What the server in use has said about its API level, for Raycast.
 *
 * One `createServerLevelCache` per process, persisted in `LocalStorage`: every
 * command is a fresh process, so without the stored copy each launch would
 * start knowing nothing and every gate would read "unknown". Always hydrate
 * before a read or a write — a write before hydration would persist this
 * process's partial list over the stored one.
 *
 * Refreshed on command start (throttled, below), after an offline flush that
 * met a server without a procedure, and — without any extra detection — on a
 * change of the API URL preference: the cache is keyed by origin, so a new
 * origin has no entry and the next start asks it.
 */
import { useEffect, useState } from "react";
import {
  createServerLevelCache,
  type Capability,
  type ServerLevel,
  type ServerLevelCache,
  type VersionRefusal,
} from "@starter/core";
import { compatibilityBanner, type CompatibilityBanner } from "./compatibility-copy.js";
import { apiUrl } from "./preferences.js";
import { raycastStorage } from "./storage.js";

/**
 * How long a health read stands before a command start asks again. The menu
 * bar command runs every minute, and a server's level changes only when its
 * operator upgrades it.
 */
const REFRESH_AFTER_MS = 10 * 60 * 1000;

let cache: ServerLevelCache | null = null;

/** The hydrated cache for this process. */
export const serverLevels = async (): Promise<ServerLevelCache> => {
  cache ??= createServerLevelCache({ storage: raycastStorage });
  await cache.hydrate();
  return cache;
};

/**
 * Ask `origin` for its level unless a read younger than {@link REFRESH_AFTER_MS}
 * is stored. `force` skips the throttle. Never throws: a failed read keeps
 * what was known.
 */
export async function refreshServerLevel(
  origin: string = apiUrl(),
  options: { force?: boolean } = {},
): Promise<ServerLevel | null> {
  try {
    const levels = await serverLevels();
    const known = levels.get(origin);
    const age = known ? Date.now() - Date.parse(known.checkedAt) : Number.NaN;
    if (!options.force && known && age >= 0 && age < REFRESH_AFTER_MS) return known;
    return await levels.refresh(origin);
  } catch {
    return null;
  }
}

/** The stored level of `origin`, or null when it was never learned. */
export async function knownServerApiLevel(origin: string = apiUrl()): Promise<number | null> {
  try {
    return (await serverLevels()).apiLevel(origin);
  } catch {
    return null;
  }
}

/** A request to `origin` was refused as `CLIENT_TOO_OLD`. */
export async function noteClientTooOld(origin: string = apiUrl()): Promise<void> {
  try {
    (await serverLevels()).noteClientTooOld(origin);
  } catch {
    // A banner that does not appear is the whole cost.
  }
}

export type ServerLevelState = {
  level: ServerLevel | null;
  compatibility: VersionRefusal | null;
  banner: CompatibilityBanner | null;
  /** `serverSupports` for the server in use; true while its level is unknown. */
  supports: (capability: Capability) => boolean;
};

/**
 * The server in use, as far as this Mac knows, re-rendered when that changes.
 * Mounting it is the "command start" refresh: it kicks off a throttled health
 * read without holding the render.
 */
export function useServerLevel(): ServerLevelState {
  const origin = apiUrl();
  const [, setVersion] = useState(0);
  const [levels, setLevels] = useState<ServerLevelCache | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void serverLevels()
      .then((ready) => {
        if (cancelled) return;
        setLevels(ready);
        unsubscribe = ready.subscribe(() => setVersion((n) => n + 1));
        void refreshServerLevel(origin);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [origin]);

  const level = levels?.get(origin) ?? null;
  const compatibility = levels?.compatibility(origin) ?? null;
  return {
    level,
    compatibility,
    banner: compatibilityBanner(compatibility, level),
    supports: (capability) => (levels ? levels.supports(origin, capability) : true),
  };
}
