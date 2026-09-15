"use client";

/**
 * Pointing this device at a different server, safely.
 *
 * Saving an address is one line (`saveServerChoice`). Leaving a server is not,
 * and every step below has a way to go quietly wrong:
 *
 *  1. **Sign out of the OLD server first**, while requests still go there. The
 *     `signOut` wrapper revokes the session server-side, forgets the Keychain
 *     token and seals the offline queue's owner. Done after the switch, the
 *     sign-out would be sent to the new server, which has never heard of the
 *     token, and the old session would stay live in that server's devices
 *     list forever.
 *  2. **Drop cached reads.** The running-timer mirror in Preferences describes
 *     an entry on the old server; seeded at the next launch, it would put a
 *     timer on screen that the new server has never seen. React Query's cache
 *     is in memory only, and the reload at the end drops it.
 *  3. **Keep the offline queue.** Its rows are time no server has received,
 *     and each one is stamped with the server it was queued against, so the
 *     flush filter in `lib/offline.ts` never sends them to the new server —
 *     they wait, listed in Settings → Devices, for a switch back.
 *  4. **Save the choice, then reload.** The auth client, the tRPC link and the
 *     socket are all module-scope singletons; a reload is the one way to be
 *     sure no in-memory state from the old server survives into the new one.
 *
 * Native only in practice — the web app has no choice to make, and the picker
 * that calls this never renders there.
 */

import { sameServerOrigin } from "@starter/core";

import {
  getAbsoluteApiOrigin,
  saveServerChoice,
  type ServerChoice,
} from "@/lib/api-origin";

export type ServerSwitchDeps = {
  currentOrigin: () => string;
  /** Whether this device holds a session for the current server. */
  hasSession: () => boolean;
  /** The `lib/auth-client` wrapper: revoke, forget the token, seal the queue owner. */
  signOut: () => Promise<unknown>;
  /** When there was no session to sign out of, the queue owner is still sealed. */
  sealQueueOwner: () => Promise<unknown>;
  clearRunningMirror: () => Promise<unknown>;
  saveChoice: (choice: ServerChoice | null) => Promise<void>;
  /** Hand the new server's session to the device, when the caller has one. */
  adoptToken: (token: string) => Promise<void>;
  refreshPending: () => Promise<unknown>;
  /** Start over at `path` with nothing from the old server in memory. */
  restart: (path: string) => void;
};

export type SwitchServerOptions = {
  /**
   * A session token already issued by the NEW server — the move flow signs in
   * there before it switches. Kept, so the device lands signed in.
   */
  token?: string;
  /** Where to land. Defaults to the sign-in screen, or the tracker with a token. */
  landOn?: string;
};

export type SwitchServerResult = "unchanged" | "switched";

export const createServerSwitch =
  (deps: ServerSwitchDeps) =>
  async (
    next: ServerChoice | null,
    defaultOrigin: string,
    options: SwitchServerOptions = {},
  ): Promise<SwitchServerResult> => {
    const target = next?.origin ?? defaultOrigin;

    if (sameServerOrigin(target, deps.currentOrigin())) {
      // Same server: only what it said about itself may have changed.
      await deps.saveChoice(next);
      return "unchanged";
    }

    // 1. Leave the old server while requests still go to it. A sign-out the
    //    network never delivers must not keep the person on the old server.
    try {
      if (deps.hasSession()) await deps.signOut();
      else await deps.sealQueueOwner();
    } catch {
      /* best effort — the local half is what matters, and it runs regardless */
    }

    // 2. Nothing cached about the old server may seed the new one.
    await deps.clearRunningMirror().catch(() => undefined);

    // 3. The queue is deliberately untouched: its rows carry their server.

    // 4. Point the device at the new server.
    await deps.saveChoice(next);
    if (options.token) await deps.adoptToken(options.token);
    await deps.refreshPending().catch(() => undefined);

    deps.restart(options.landOn ?? (options.token ? "/app/track/" : "/login/"));
    return "switched";
  };

/** The switch wired to this app's real storage, auth client and window. */
export const switchServer = async (
  next: ServerChoice | null,
  options: SwitchServerOptions = {},
): Promise<SwitchServerResult> => {
  // Loaded here rather than at module scope: the auth client pulls in
  // better-auth, and the login page's picker should not make every consumer of
  // this module do the same.
  const [
    { signOut },
    { getNativeToken, setNativeToken },
    { sealOfflineQueueOwner, refreshPendingCount },
    { writeRunningMirror },
    { getDefaultApiOrigin },
  ] = await Promise.all([
    import("@/lib/auth-client"),
    import("@/lib/native-session"),
    import("@/lib/offline"),
    import("@/lib/running-mirror"),
    import("@/lib/api-origin"),
  ]);

  const run = createServerSwitch({
    currentOrigin: getAbsoluteApiOrigin,
    hasSession: () => getNativeToken() !== null,
    signOut: () => signOut(),
    sealQueueOwner: sealOfflineQueueOwner,
    clearRunningMirror: () => writeRunningMirror(null),
    saveChoice: saveServerChoice,
    adoptToken: setNativeToken,
    refreshPending: refreshPendingCount,
    restart: (path) => window.location.replace(path),
  });
  return run(next, getDefaultApiOrigin(), options);
};
