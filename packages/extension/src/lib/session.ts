/**
 * The stored better-auth session token.
 *
 * It lives in `chrome.storage.session` on purpose: that area is memory-only,
 * so the token never lands on disk and dies with the browser process. The
 * price is signing in again after a browser restart, which is the trade we
 * want — do not move this to `chrome.storage.local`.
 *
 * Only the service worker should touch these; the popup asks it for state.
 */
import { chromeStorage, sessionStorageArea } from "./chrome-storage";

export const SESSION_STORAGE_KEY = "trackyourtime.session";

/** Shaped like core's `IssuedSession` — `token` is the credential. */
export type StoredSession = {
  token: string;
  userId: string | null;
  email: string | null;
};

const storage = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(sessionStorageArea());

const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Read the session back, or null when there is none. A malformed record is
 * treated as "signed out" rather than an error: the only recovery is signing
 * in again anyway, and throwing here would blank the popup.
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
    };
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await storage().setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await storage().removeItem(SESSION_STORAGE_KEY);
}
