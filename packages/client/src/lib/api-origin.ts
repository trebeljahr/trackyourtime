"use client";

/**
 * Which server this client talks to.
 *
 * **On web the answer never changes.** The web app talks to the origin it was
 * built for — `NEXT_PUBLIC_API_URL`, or the page's own origin for the
 * same-origin self-host image — and every export here returns exactly that.
 * Nothing on web reads storage, awaits anything or rewrites a URL, so a web
 * request is byte-identical to what it was before this module existed.
 *
 * **On the phone apps it is the person's choice.** A store-installed app is one
 * build for everyone, so the baked-in `NEXT_PUBLIC_API_URL` is only the
 * default: the login screen can point the app at any Track Your Time server,
 * and that choice is stored in Capacitor Preferences — app-container data iOS
 * does not evict, unlike WKWebView's `localStorage` (see
 * `mobile/preferences-storage.ts`). Not the Keychain: an address is not a
 * credential, and unlike the token it should NOT outlive a reinstall.
 *
 * Every client built at module scope keeps its build-time URL — the tRPC link,
 * better-auth's `baseURL` — and each request is rebased onto the chosen origin
 * at send time with {@link rebaseApiUrl}, after {@link whenApiOriginReady}. That
 * is what makes the choice safe to read asynchronously: no request can leave
 * before the stored answer is known, and none can leave for the wrong server.
 *
 * The published snapshot follows `lib/native-session.ts`: the prerender and
 * the first client render both see the default, so nothing that reads this
 * can make the served HTML disagree with hydration.
 */

import { sameServerOrigin } from "@starter/core";

import { isNative } from "@/mobile/bridge";
import { preferencesStorage } from "@/mobile/preferences-storage";

/** Preferences key holding the chosen server. Absent means the build default. */
export const SERVER_CHOICE_STORAGE_KEY = "trackyourtime.server-choice";

const trimOrigin = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The origin this build was made for. Empty for the same-origin web image.
 * A function rather than a constant only so a test can stub the variable
 * after import; Next inlines the literal either way.
 */
export const getDefaultApiOrigin = (): string =>
  trimOrigin(process.env.NEXT_PUBLIC_API_URL ?? "");

/** A server somebody picked, with what it said about itself when it was checked. */
export type ServerChoice = {
  origin: string;
  /** Where that server's web app lives, for "open in a browser" links. */
  webUrl: string | null;
  release: string | null;
};

export type ApiOriginSnapshot = {
  /** The picked server on native, or null for the build default. */
  choice: ServerChoice | null;
  /** True once the stored choice has been read. Always true on web. */
  ready: boolean;
};

// ── the store ────────────────────────────────────────────────────────

type Listener = () => void;

const listeners = new Set<Listener>();
let choice: ServerChoice | null = null;
let ready = false;
let snapshot: ApiOriginSnapshot = { choice: null, ready: false };

const publish = (): void => {
  snapshot = { choice, ready };
  for (const listener of listeners) listener();
};

export const subscribeApiOrigin = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getApiOriginSnapshot = (): ApiOriginSnapshot => snapshot;

const SERVER_SNAPSHOT: ApiOriginSnapshot = { choice: null, ready: false };

/** Prerender snapshot — the default, which is also the first client render's. */
export const getServerApiOriginSnapshot = (): ApiOriginSnapshot => SERVER_SNAPSHOT;

// ── reads ────────────────────────────────────────────────────────────

/**
 * The API origin requests go to. Empty means "the page's own origin", which
 * only the same-origin web image uses — no native build can be made without a
 * `NEXT_PUBLIC_API_URL` (`scripts/build-mobile.mjs` refuses).
 */
export const getApiOrigin = (): string =>
  isNative() && choice !== null ? choice.origin : getDefaultApiOrigin();

/** {@link getApiOrigin}, resolved against the page when it is empty. */
export const getAbsoluteApiOrigin = (): string => {
  const origin = getApiOrigin();
  if (origin !== "" || typeof window === "undefined") return origin;
  return window.location.origin;
};

/**
 * The server this build was made for, absolute. What an offline row written
 * before server stamping existed was queued against.
 */
export const getDefaultAbsoluteApiOrigin = (): string => {
  const origin = getDefaultApiOrigin();
  return origin !== "" || typeof window === "undefined"
    ? origin
    : window.location.origin;
};

/** True when native and pointed somewhere other than the build default. */
export const isUsingChosenServer = (): boolean =>
  isNative() &&
  choice !== null &&
  !sameServerOrigin(choice.origin, getDefaultApiOrigin());

/** The chosen server's web app, when one was picked and it said where. */
export const getChosenWebUrl = (): string | null =>
  isNative() ? (choice?.webUrl ?? null) : null;

/**
 * Point a URL built against the default origin at the chosen one.
 *
 * Only a URL that starts with the default origin is touched, so anything else
 * — a third-party fetch that happens to pass through, a URL already rebased —
 * goes out unchanged. On web this is the identity function.
 */
export const rebaseApiUrl = (url: string): string => {
  const fallback = getDefaultApiOrigin();
  if (!isUsingChosenServer() || choice === null || fallback === "") return url;
  if (url === fallback || url.startsWith(`${fallback}/`)) {
    return `${choice.origin}${url.slice(fallback.length)}`;
  }
  return url;
};

// ── hydration ────────────────────────────────────────────────────────

const storage = (): ReturnType<typeof preferencesStorage> => preferencesStorage();

const decodeChoice = (raw: string | null): ServerChoice | null => {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.origin !== "string" || record.origin === "") return null;
    return {
      origin: trimOrigin(record.origin),
      webUrl: typeof record.webUrl === "string" ? record.webUrl : null,
      release: typeof record.release === "string" ? record.release : null,
    };
  } catch {
    return null;
  }
};

/**
 * How long the launch path waits for Preferences. The same reasoning as the
 * Keychain deadline in `lib/native-session.ts`: every request waits on this,
 * so a plugin that never answers must degrade to the default rather than
 * freeze the app behind its splash.
 */
const HYDRATE_TIMEOUT_MS = 5000;

let hydration: Promise<void> | null = null;
/** Set by a save, so a slow read can never overwrite what was just chosen. */
let saved = false;

const runHydration = async (): Promise<void> => {
  if (!isNative()) {
    ready = true;
    publish();
    return;
  }

  const read = (async () => {
    try {
      const stored = decodeChoice(await storage().getItem(SERVER_CHOICE_STORAGE_KEY));
      // A choice saved while the read was in flight is the newer answer. A read
      // that lands after the deadline still counts, and is published.
      if (!saved) {
        choice = stored;
        if (ready) publish();
      }
    } catch {
      /* unreadable is the default, never a crash on the launch path */
    }
  })();

  await Promise.race([
    read,
    new Promise<void>((resolve) => {
      setTimeout(resolve, HYDRATE_TIMEOUT_MS);
    }),
  ]);

  ready = true;
  publish();
};

/** Read the stored choice. Idempotent; every caller awaits one read. */
export const hydrateApiOrigin = (): Promise<void> => {
  hydration ??= runHydration();
  return hydration;
};

/**
 * Resolves once a request may be sent. Synchronous-ready on web in all but
 * name — callers there skip it entirely rather than await it.
 */
export const whenApiOriginReady = (): Promise<void> =>
  isNative() ? hydrateApiOrigin() : Promise.resolve();

// ── writes ───────────────────────────────────────────────────────────

/**
 * Store a new server choice; `null` goes back to the build default. Native
 * only — the web app has no choice to make.
 *
 * This only records the address. Leaving the old server safely (signing out,
 * dropping cached reads, keeping its queued rows out of the new one) is
 * `switchServer` in `lib/server-switch.ts`, which calls this.
 */
export const saveServerChoice = async (next: ServerChoice | null): Promise<void> => {
  if (!isNative()) return;
  const normalized =
    next === null || sameServerOrigin(next.origin, getDefaultApiOrigin())
      ? null
      : { ...next, origin: trimOrigin(next.origin) };

  saved = true;
  choice = normalized;
  ready = true;
  publish();

  const store = storage();
  if (normalized === null) {
    await store.removeItem(SERVER_CHOICE_STORAGE_KEY);
  } else {
    await store.setItem(SERVER_CHOICE_STORAGE_KEY, JSON.stringify(normalized));
  }
};

/** Test seam. */
export const __resetApiOriginForTests = (): void => {
  choice = null;
  ready = false;
  saved = false;
  hydration = null;
  snapshot = { choice: null, ready: false };
};
