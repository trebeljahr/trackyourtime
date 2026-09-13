"use client";

/**
 * Which language the web app is rendering, held outside React.
 *
 * Same shape as the theme store in components/theme-toggle.tsx, for the same
 * reasons: a pre-paint script has already decided the answer before React
 * exists, the two places that change it (Settings and the server sync) live in
 * different trees, and non-React code — a toast fired from a mutation callback —
 * must read the same value the components render.
 *
 * TWO values, and the difference is the whole hydration story:
 *
 *  - `target` is what the person wants: their stored preference resolved
 *    against the device's languages. Known at module load.
 *  - `current` is what React has been told to render. It starts as "en" —
 *    the language every prerendered HTML file is written in — and only becomes
 *    `target` in <LocaleRoot>'s layout effect, AFTER hydration has matched the
 *    served English DOM. Rendering `target` during hydration would be a text
 *    mismatch on every string of a German user's first paint.
 *
 * The pre-paint gate (LOCALE_SCRIPT + `data-locale-pending`) hides the page for
 * the frames in between, so the English hydration pass is never seen.
 */

import * as React from "react";
import {
  isLocalePreference,
  resolveLocalePreference,
  type LocalePreference,
} from "@starter/shared";

import {
  htmlLang,
  LOCALE_OVERRIDE_STORAGE_KEY,
  LOCALE_PENDING_ATTRIBUTE,
  LOCALE_STORAGE_KEY,
  PRERENDER_LOCALE,
  PSEUDO_LOCALE_ENABLED,
  type ClientLocale,
} from "@/i18n/config";

export type { ClientLocale };

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null): void => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode — the choice simply does not survive a reload */
  }
};

/** The stored preference, or "system" when there is none. */
export const readStoredPreference = (): LocalePreference => {
  if (typeof window === "undefined") return "system";
  const stored = readStorage(LOCALE_STORAGE_KEY);
  return isLocalePreference(stored) ? stored : "system";
};

const deviceLanguages = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
};

/**
 * Whether the pseudo-locale is switched on for this browser.
 *
 * `?locale=pseudo` turns it on and persists that; `?locale=off` turns it off.
 * Keep this in lockstep with LOCALE_SCRIPT, which makes the same decision
 * before first paint — if the two disagree the gate is released on a page in
 * the wrong language.
 */
export const readPseudoOverride = (): boolean => {
  if (!PSEUDO_LOCALE_ENABLED || typeof window === "undefined") return false;
  let query: string | null = null;
  try {
    query = new URLSearchParams(window.location.search).get("locale");
  } catch {
    query = null;
  }
  if (query === "pseudo") {
    writeStorage(LOCALE_OVERRIDE_STORAGE_KEY, "pseudo");
    return true;
  }
  if (query === "off") {
    writeStorage(LOCALE_OVERRIDE_STORAGE_KEY, null);
    return false;
  }
  return readStorage(LOCALE_OVERRIDE_STORAGE_KEY) === "pseudo";
};

/** What this device should render, from scratch. */
export const resolveTargetLocale = (): ClientLocale => {
  if (readPseudoOverride()) return "pseudo";
  return resolveLocalePreference(readStoredPreference(), deviceLanguages());
};

// ── the store ────────────────────────────────────────────────────────

type Listener = () => void;

type LocaleState = {
  preference: LocalePreference;
  pseudo: boolean;
  target: ClientLocale;
  current: ClientLocale;
};

let state: LocaleState = {
  preference: "system",
  pseudo: false,
  target: PRERENDER_LOCALE,
  current: PRERENDER_LOCALE,
};
let initialised = false;
/** True once <LocaleRoot> has made the first switch; see `applyPreference`. */
let hydrated = false;
const listeners = new Set<Listener>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

/** The prerendered German public pages, which own their `lang` outright. */
const onGermanStaticPage = (): boolean =>
  typeof location !== "undefined" && /^\/de(\/|$)/.test(location.pathname);

const syncHtml = (locale: ClientLocale): void => {
  if (typeof document === "undefined" || onGermanStaticPage()) return;
  const root = document.documentElement;
  root.lang = htmlLang(locale);
  root.setAttribute("data-locale", locale);
};

/** Reads storage and the device once, lazily — never during a server render. */
const ensureInitialised = (): boolean => {
  if (initialised || typeof window === "undefined") return false;
  initialised = true;
  const pseudo = readPseudoOverride();
  const preference = readStoredPreference();
  state = {
    ...state,
    preference,
    pseudo,
    target: pseudo ? "pseudo" : resolveLocalePreference(preference, deviceLanguages()),
  };
  return true;
};

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getCurrent = (): ClientLocale => state.current;
const getPrerender = (): ClientLocale => PRERENDER_LOCALE;
const getPreferenceSnapshot = (): LocalePreference => state.preference;
const getPrerenderPreference = (): LocalePreference => "system";
const getPseudoSnapshot = (): boolean => state.pseudo;
const getPrerenderPseudo = (): boolean => false;

/**
 * The locale non-React code should format with — a toast text, a download
 * filename. Components use `useLocale()` instead, which re-renders on change.
 */
export const getActiveLocale = (): ClientLocale => state.current;

/** What the device WANTS to render; differs from `current` only before the first switch. */
export const getTargetLocale = (): ClientLocale => {
  ensureInitialised();
  return state.target;
};

/**
 * Make React render the target. Called once by <LocaleRoot> after hydration,
 * and by every change after that. Idempotent.
 */
export const commitTargetLocale = (): void => {
  const loaded = ensureInitialised();
  hydrated = true;
  syncHtml(state.target);
  if (state.current === state.target) {
    // The preference itself may still be news to a subscriber (the picker).
    if (loaded) emit();
    return;
  }
  state = { ...state, current: state.target };
  emit();
};

/** Lifts the pre-paint gate. Safe to call when it was never set. */
export const releaseLocaleGate = (): void => {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
};

const applyPreference = (preference: LocalePreference): void => {
  ensureInitialised();
  writeStorage(LOCALE_STORAGE_KEY, preference);
  const target: ClientLocale = state.pseudo
    ? "pseudo"
    : resolveLocalePreference(preference, deviceLanguages());
  state = { ...state, preference, target };
  // Only switch the rendered language once the first commit has happened;
  // before that, <LocaleRoot> owns the switch and hydration must stay English.
  if (hydrated) {
    state = { ...state, current: target };
    syncHtml(target);
  }
  emit();
};

/**
 * Where a deliberate language change is published so it reaches the server.
 * {@link LocaleSync} registers it; with none registered the choice stays on
 * this device (the signed-out screens).
 */
type LocaleSink = (preference: LocalePreference) => void;
let sink: LocaleSink | null = null;

export const setLocaleSink = (next: LocaleSink | null): void => {
  sink = next;
};

/** A choice made by the person on this device: stored, applied, sent. */
export const setLocalePreference = (preference: LocalePreference): void => {
  applyPreference(preference);
  sink?.(preference);
};

/**
 * A choice that came FROM the server. Never echoed back to the sink — that
 * would write the server's own answer to it on every settings refetch.
 */
export const adoptLocalePreference = (preference: LocalePreference): void => {
  if (preference === state.preference && initialised) return;
  applyPreference(preference);
};

/** Dev-only: switch the pseudo-locale on or off for this browser. */
export const setPseudoLocale = (on: boolean): void => {
  if (!PSEUDO_LOCALE_ENABLED) return;
  ensureInitialised();
  writeStorage(LOCALE_OVERRIDE_STORAGE_KEY, on ? "pseudo" : null);
  state = { ...state, pseudo: on };
  applyPreference(state.preference);
};

// ── hooks ────────────────────────────────────────────────────────────

/**
 * Pins a subtree to one locale regardless of the preference. Used by the
 * public pages, which are prerendered once per language (/ and /de/) and must
 * never switch after load. See <FixedLocale>.
 */
export const FixedLocaleContext = React.createContext<ClientLocale | null>(null);

/**
 * The locale this component renders in. Re-renders when it changes.
 *
 * Returns "en" during hydration by construction (`getServerSnapshot`), so it
 * can never produce a hydration mismatch against the prerendered HTML.
 */
export const useLocale = (): ClientLocale => {
  const fixed = React.useContext(FixedLocaleContext);
  const current = React.useSyncExternalStore(subscribe, getCurrent, getPrerender);
  return fixed ?? current;
};

/** The stored preference ("system" | "en" | "de"), for the Settings picker. */
export const useLocalePreference = (): { preference: LocalePreference; pseudo: boolean } => {
  const preference = React.useSyncExternalStore(
    subscribe,
    getPreferenceSnapshot,
    getPrerenderPreference,
  );
  const pseudo = React.useSyncExternalStore(subscribe, getPseudoSnapshot, getPrerenderPseudo);
  return { preference, pseudo };
};

/** Test-only: forget everything, as a fresh page load would. */
export const resetLocaleStoreForTests = (): void => {
  state = {
    preference: "system",
    pseudo: false,
    target: PRERENDER_LOCALE,
    current: PRERENDER_LOCALE,
  };
  initialised = false;
  hydrated = false;
  sink = null;
  emit();
};
