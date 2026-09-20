/*
 * Which documents the main process will talk to, and which URLs the window
 * may show. Pure functions (trust.test.ts); security.ts and ipc.ts apply them.
 */

import { DESKTOP_APP_ORIGIN } from "../../packages/shared/src/desktop-bridge.ts";

/** A URL on the packaged app's own origin, `app://-`. */
export function isAppUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}` === DESKTOP_APP_ORIGIN;
  } catch {
    return false;
  }
}

/** Same origin as the dev server `dev:desktop` loads, when there is one. */
export function isDevUrl(url: string | null | undefined, devUrl: string | null): boolean {
  if (!url || !devUrl) return false;
  try {
    return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

/**
 * May a frame at `url` call the bridge? Only the app's own documents: the
 * export over `app://-`, or the dev server in `dev:desktop`. Anything else — a
 * page navigated to by mistake, an `about:blank` frame, a `data:` URL — gets
 * a refusal, however it came to have the preload.
 */
export function isTrustedSenderUrl(url: string | null | undefined, devUrl: string | null): boolean {
  return isAppUrl(url) || isDevUrl(url, devUrl);
}

/** An http(s) URL, the only kind handed to the OS browser. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
