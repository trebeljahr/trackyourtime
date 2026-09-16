"use client";

/**
 * The API level of the server this device talks to (`ServerLevelCache` in
 * core), for the web app and the phone shells.
 *
 * Refreshed at app start (`AppShell`), on a resume (`use-native-lifecycle.ts`),
 * after a server switch (the picker records what it checked) and whenever a
 * replay is held because the server lacks a procedure. A cache and nothing
 * more, so it lives in `localStorage` on every platform — eviction costs one
 * health read. What it answers:
 *
 *  - `serverSupportsNow(capability)` — feature gating, docs/versioning.md →
 *    "Gating a feature on the server";
 *  - `currentServerApiLevel()` — the offline flush holds rows the server is
 *    too old for;
 *  - `useServerCompatibility()` — the banner in the app shell.
 */
import * as React from "react";
import {
  createServerLevelCache,
  memoryStorage,
  webStorage,
  type Capability,
  type KeyValueStorage,
  type ServerLevel,
  type ServerLevelCache,
  type VersionRefusal,
} from "@starter/core";

import { getAbsoluteApiOrigin, whenApiOriginReady } from "@/lib/api-origin";

const resolveStorage = (): KeyValueStorage => {
  if (typeof window === "undefined") return memoryStorage();
  try {
    return webStorage(window.localStorage);
  } catch {
    return memoryStorage();
  }
};

let cache: ServerLevelCache | null = null;

export const getServerLevelCache = (): ServerLevelCache => {
  cache ??= createServerLevelCache({ storage: resolveStorage() });
  return cache;
};

/** Tests only. */
export const __setServerLevelCacheForTests = (next: ServerLevelCache | null): void => {
  cache = next;
};

/**
 * Ask the server in use for its level again. Waits for the stored server
 * choice on a phone, so the answer is about the server requests go to.
 * Never throws: a failed read keeps what was known.
 */
export const refreshServerLevel = async (): Promise<ServerLevel | null> => {
  const levels = getServerLevelCache();
  await levels.hydrate();
  await whenApiOriginReady();
  return levels.refresh(getAbsoluteApiOrigin()).catch(() => null);
};

/** The known level of the server in use, or null. */
export const currentServerApiLevel = (): number | null =>
  getServerLevelCache().apiLevel(getAbsoluteApiOrigin());

/**
 * Whether the server in use has `capability`. Unknown answers true — see
 * `serverSupports` in `@starter/shared`.
 */
export const serverSupportsNow = (capability: Capability): boolean =>
  getServerLevelCache().supports(getAbsoluteApiOrigin(), capability);

/** A request to the server in use was refused as `CLIENT_TOO_OLD`. */
export const noteClientTooOld = (): void => {
  getServerLevelCache().noteClientTooOld(getAbsoluteApiOrigin());
};

export type ServerCompatibilityState = {
  refusal: VersionRefusal;
  level: ServerLevel | null;
} | null;

const subscribe = (listener: () => void): (() => void) =>
  getServerLevelCache().subscribe(listener);

// `useSyncExternalStore` needs a stable snapshot between changes.
let lastKey = "";
let lastSnapshot: ServerCompatibilityState = null;

const snapshot = (): ServerCompatibilityState => {
  const origin = getAbsoluteApiOrigin();
  const levels = getServerLevelCache();
  const refusal = levels.compatibility(origin);
  const level = levels.get(origin);
  const key = refusal === null ? "" : `${refusal}|${JSON.stringify(level)}`;
  if (key !== lastKey) {
    lastKey = key;
    lastSnapshot = refusal === null ? null : { refusal, level };
  }
  return lastSnapshot;
};

/** Nothing on the server and during hydration: the prerender knows no server. */
const serverSnapshot = (): ServerCompatibilityState => null;

/**
 * Which side is too old, as React state. `null` in the prerendered HTML and
 * on the hydrating render by construction, so a banner built on it cannot
 * cause a hydration mismatch.
 */
export const useServerCompatibility = (): ServerCompatibilityState => {
  const state = React.useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
    void getServerLevelCache().hydrate();
  }, []);
  return mounted ? state : null;
};

/** `serverSupportsNow` as React state, re-rendering when the level changes. */
export const useServerSupports = (capability: Capability): boolean => {
  const read = React.useCallback(() => serverSupportsNow(capability), [capability]);
  return React.useSyncExternalStore(subscribe, read, () => true);
};
