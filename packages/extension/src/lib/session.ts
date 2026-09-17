/**
 * The stored better-auth session token.
 *
 * It lives in `chrome.storage.session` on purpose: that area is memory-only,
 * so the token never lands on disk and dies with the browser process. The
 * price is signing in again after a browser restart — for a session linked to
 * the web app, that happens by itself the next time a Track Your Time tab
 * loads (`background/bridge.ts`). Do not move this to `chrome.storage.local`.
 *
 * Only the service worker should touch these; the popup asks it for state.
 */
import { chromeStorage, sessionStorageArea } from "./chrome-storage";

export const SESSION_STORAGE_KEY = "trackyourtime.session";

/**
 * How the extension's session came to be. Every one of them is a session row
 * of the extension's own — none is shared with the web app any more.
 *
 * - `web`: the web app handed the extension a device code to approve, because
 *   somebody signed in there (`background/bridge.ts`). A web sign-out or an
 *   account switch in the web app ends it.
 * - `password`: somebody typed a password into the popup.
 * - `device`: somebody pressed "Sign in with the web app" and approved the
 *   code in a browser tab.
 *
 * `password` and `device` are signed in to on purpose, and nothing the web app
 * does displaces them.
 */
export type SessionSource = "web" | "password" | "device";

/** Shaped like core's `IssuedSession` — `token` is the credential. */
export type StoredSession = {
  token: string;
  userId: string | null;
  email: string | null;
  source: SessionSource;
};

/** What a caller saves: a missing `source` is a password session, as on read. */
export type SessionInput = Omit<StoredSession, "source"> & { source?: SessionSource };

const storage = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(sessionStorageArea());

const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const readSource = (value: unknown): SessionSource =>
  value === "web" || value === "device" ? value : "password";

/**
 * Read the session back, or null when there is none. A malformed record is
 * treated as "signed out" rather than an error: the only recovery is signing
 * in again anyway, and throwing here would blank the popup.
 *
 * A record without `source` was written before the field existed, when the
 * only stored session was a password one.
 */
export async function loadSession(): Promise<StoredSession | null> {
  const raw = await storage().getItem(SESSION_STORAGE_KEY);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    const token = asStringOrNull(record.token);
    if (token === null) return null;

    return {
      token,
      userId: asStringOrNull(record.userId),
      email: asStringOrNull(record.email),
      source: readSource(record.source),
    };
  } catch {
    return null;
  }
}

export async function saveSession(session: SessionInput): Promise<void> {
  const stored: StoredSession = { ...session, source: session.source ?? "password" };
  await storage().setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
}

export async function clearSession(): Promise<void> {
  await storage().removeItem(SESSION_STORAGE_KEY);
}
