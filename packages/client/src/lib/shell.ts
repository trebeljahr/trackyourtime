import {
  ANDROID_APP_ORIGIN,
  DESKTOP_APP_ORIGIN,
  IOS_APP_ORIGIN,
  type EntrySource,
} from "@starter/shared";

/**
 * Which host this export is running in, split by what a caller means.
 *
 * One static export runs in a browser, an installed PWA, the Capacitor phone
 * shells and the Electron desktop app. The old single `isNative()` meant
 * three different things at once — "phone UI", "no cookie jar, use the bearer
 * token" and "WKWebView storage and radio" — and the desktop app wants only
 * the second. So there is one predicate per meaning, and no ambiguous one:
 *
 *  - {@link isCapacitor}: the phone. Phone chrome, Preferences-backed storage,
 *    the radio's network verdict, battery-bounded retries.
 *  - {@link isElectron}: the desktop app. Window chrome and desktop-only
 *    affordances.
 *  - {@link isTokenShell}: either. No usable cookie (the document origin is
 *    cross-site to the API), so the session is a bearer token in secure
 *    storage, and the person may point the app at another server.
 *
 * All synchronous reads of globals the shell injects before any app script
 * runs (`window.Capacitor` at document start, `window.electronAPI` from the
 * preload), so the answer is right on the first call. Every one of them is
 * `false` while prerendering in Node: never branch a first render on them —
 * use `hooks/use-shell.ts`, which hydrates as the web tree.
 */

type CapacitorGlobal = { isNativePlatform?: () => boolean };

/** The iOS or Android app. */
export function isCapacitor(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

/** The Electron desktop app. */
export function isElectron(): boolean {
  if (typeof window === "undefined") return false;
  return window.electronAPI?.isDesktop === true;
}

/** A shell that authenticates with a stored bearer token: phone or desktop. */
export function isTokenShell(): boolean {
  return isCapacitor() || isElectron();
}

/** How this client names itself (`x-trackyourtime-client`, device-flow `client_id`). */
export type ShellClientId = "web" | "trackyourtime-mobile" | "trackyourtime-desktop";

export function clientId(): ShellClientId {
  if (isCapacitor()) return "trackyourtime-mobile";
  if (isElectron()) return "trackyourtime-desktop";
  return "web";
}

/**
 * Which client an entry was tracked from.
 *
 * `source` is stamped once, at write time, and is not backfillable — nothing
 * later in the entry's life knows where it came from. The read is synchronous,
 * so there is no window in which a shell's write is mislabelled "web".
 */
export function entrySource(): EntrySource {
  if (isCapacitor()) return "mobile";
  if (isElectron()) return "desktop";
  return "web";
}

/**
 * The document origins a server must trust for this shell to sign in, as
 * written into TRUSTED_ORIGINS — what the "does not accept sign-ins from this
 * app" messages tell a server's administrator to add. Not translated: it is a
 * value to copy.
 */
export function shellTrustedOrigins(): string {
  if (isElectron()) return DESKTOP_APP_ORIGIN;
  return `${IOS_APP_ORIGIN},${ANDROID_APP_ORIGIN}`;
}
