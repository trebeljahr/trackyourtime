"use client";

/**
 * What this device does when the server says its session is gone.
 *
 * The server sweeps live sockets every 60s and closes the ones whose session
 * no longer exists with `SESSION_REVOKED_CLOSE_CODE` (4401) — "signed out in
 * Settings → Devices", "expired", "deleted". `@starter/core`'s sync client
 * recognises that code, stops reconnecting on it and calls back here.
 *
 * Three things have to happen, and the order matters:
 *
 *  1. **Count the queue before touching the session.** The number is what the
 *     login screen says out loud, and every later step can fail.
 *  2. **Forget the credential** — better-auth's cookie/session store on web,
 *     the Keychain item on native (`signOut()` in `lib/auth-client.ts` does
 *     both, and `clearNativeToken()` runs again here because the sign-out
 *     request itself is expected to fail: the session it would end is already
 *     gone). A token the server has rejected must not be re-read on the next
 *     launch and quietly resume a dead session.
 *  3. **Say so, and land the user somewhere they can act.** A sync dot that
 *     never settles is not a message; the login screen is.
 *
 * ## The offline queue is kept, deliberately
 *
 * Nothing here clears it. A revoked credential is a statement about *this
 * device's session*, not about the time the user tracked — and those rows are
 * time the server has never seen, so dropping them destroys the only copy.
 * The flush path already treats an auth failure as "stop, do not drop"
 * (`isAuthError` in `use-offline-queue`), so the rows sit in order and replay
 * on the next successful sign-in, which is the same behaviour a user gets
 * after an ordinary expiry.
 *
 * The cost of keeping them is stated rather than hidden: the login screen
 * tells the user how many unsent changes are waiting, so "my afternoon is
 * missing" has an answer on the screen the user is already looking at.
 */

export type SessionRevokedNotice = {
  /** Offline mutations still queued on this device when the session died. */
  pending: number;
};

export type SessionRevokedDeps = {
  /** How many offline mutations are still queued. */
  pendingCount: () => Promise<number>;
  /** End the session client-side: cookie store on web, Keychain on native. */
  signOut: () => Promise<unknown>;
  /** Belt and braces — the sign-out request above is expected to fail. */
  clearToken: () => Promise<void>;
  /** Tell the user now, wherever they are standing. */
  notify: (notice: SessionRevokedNotice) => void;
  /** Send them to the login screen. */
  redirect: () => void;
  /**
   * Whether the credential this device holds NOW still has a live session.
   *
   * better-auth replaces the session outright when two-factor is switched on
   * or off: a new row and cookie, the old row deleted. The socket was opened
   * with the old one, so the server's re-check correctly closes it with 4401
   * — but the device is still signed in, and every other tab of the same
   * browser shares the new cookie. Signing out there would end the NEW
   * session too. So ask first; only a clean "no session" signs out. A check
   * that throws signs out as before: the server has already said revoked.
   */
  stillSignedIn?: () => Promise<boolean>;
  /** Open a fresh socket with the current credential instead of signing out. */
  resume?: () => void;
};

// ── the notice the login screen picks up ─────────────────────────────

let notice: SessionRevokedNotice | null = null;

/**
 * Read the notice once and clear it.
 *
 * Module state rather than a query parameter: `useSearchParams` forces a
 * Suspense boundary under `output: "export"`, and a reason in the URL is one
 * a bookmark or a share can resurrect months later. This survives the
 * client-side navigation to /login — the same JS context — and nothing else,
 * which is exactly the lifetime the message deserves.
 */
export const consumeSessionRevokedNotice = (): SessionRevokedNotice | null => {
  const current = notice;
  notice = null;
  return current;
};

// ── the handler ──────────────────────────────────────────────────────

let running: Promise<void> | null = null;

const run = async (deps: SessionRevokedDeps): Promise<void> => {
  if (deps.stillSignedIn && deps.resume) {
    const live = await deps.stillSignedIn().catch(() => false);
    if (live) {
      deps.resume();
      return;
    }
  }

  let pending = 0;
  try {
    pending = await deps.pendingCount();
  } catch {
    // An unreadable queue must not stop the user being signed out.
    pending = 0;
  }

  try {
    await deps.signOut();
  } catch {
    // Expected: the session this would end is the one that no longer exists.
    // `signOut()` clears the native token in its own `finally` regardless.
  }

  try {
    await deps.clearToken();
  } catch {
    // Also expected to be harmless — and already done in the common case.
  }

  notice = { pending };
  deps.notify({ pending });
  deps.redirect();
};

/**
 * Handle a revoked session. Concurrent calls share one run.
 *
 * Not latched forever: a user who signs back in and is revoked a second time
 * in the same launch gets told a second time. The sync client is what
 * guarantees this is not called in a loop — it fires `onSessionRevoked` at
 * most once per client, and a client is built per session.
 */
export const handleSessionRevoked = (
  deps: SessionRevokedDeps,
): Promise<void> => {
  running ??= run(deps).finally(() => {
    running = null;
  });
  return running;
};

/** Test seam: forget the pending notice and any in-flight run. */
export const __resetSessionRevokedForTests = (): void => {
  notice = null;
  running = null;
};
