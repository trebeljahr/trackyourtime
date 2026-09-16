import { createAuthClient } from "better-auth/react";
import {
  deviceAuthorizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { isNative } from "@/mobile/bridge";
import {
  clearNativeToken,
  getNativeToken,
  setNativeToken,
} from "@/lib/native-session";
import { ACCOUNT_DELETION_PASSWORD_REQUIRED, versionHeaders } from "@starter/shared";
import { APP_VERSION } from "@/lib/app-version";
import {
  discardDeletedAccountQueue,
  sealOfflineQueueOwner,
} from "@/lib/offline";
import { writeRunningMirror } from "@/lib/running-mirror";
import { rebaseApiUrl, whenApiOriginReady } from "@/lib/api-origin";
import { clearActiveWorkspace } from "@/lib/active-workspace";
import { clearAppQueryCache } from "@/lib/query-client";

/**
 * better-auth validates its baseURL with `new URL()`, so a relative
 * "/api/auth" throws. With `output: "export"` every page is prerendered in
 * Node — where there is no origin and NEXT_PUBLIC_API_URL may be unset — so
 * the URL has to be resolved defensively:
 *
 *  - NEXT_PUBLIC_API_URL when set (inlined at build time for the Docker
 *    image, the desktop bundle and the mobile bundle),
 *  - the live origin in the browser, which is what same-origin web
 *    deployments use,
 *  - a throwaway absolute URL during prerendering. No auth request is made
 *    while prerendering, and the client re-resolves against the real origin
 *    on hydration.
 *
 * It deliberately does NOT throw when the URL is missing on native, tempting
 * as that is. This runs at module scope, `AuthProvider` imports it and the
 * root layout renders that — so a throw here aborts React before it mounts,
 * `MobileBridgeLoader` never calls `hideSplash()`, and a splash configured
 * with `launchAutoHide: false` stays up forever with no console to read. The
 * enforcement point is the build: `scripts/build-mobile.mjs` refuses to run
 * without `NEXT_PUBLIC_API_URL` and then greps the emitted chunks for the
 * literal, so a mis-targeted bundle cannot be produced in the first place.
 */
function resolveAuthBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return `${configured}/api/auth`;

  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/auth`;
  }

  if (process.env.NODE_ENV === "development") {
    return "http://localhost:5000/api/auth";
  }

  return "http://localhost/api/auth";
}

/**
 * How this client names itself in Settings → Devices. Read per request rather
 * than captured at module scope: Capacitor injects `window.Capacitor` before
 * the app's scripts run, but module evaluation order is not something to
 * stake a session label on.
 */
const clientHeader = (): string => (isNative() ? "trackyourtime-mobile" : "web");

/**
 * The fetch every auth call goes through.
 *
 * On web it is the global `fetch`, called exactly as better-fetch would have
 * called it. On the phone apps `baseURL` above is only the build's default
 * server, so the request waits for the stored server choice and is rebased
 * onto it (`lib/api-origin.ts`) — the auth client is built once at module
 * scope, long before the choice is read, and cannot be rebuilt per server.
 */
const authFetch: typeof fetch = (input, init) => {
  if (!isNative() || input instanceof Request) return fetch(input, init);
  return whenApiOriginReady().then(() =>
    fetch(rebaseApiUrl(String(input)), init),
  );
};

export const authClient = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
  /**
   * Adds `authClient.device.*`, which backs /device — the page where a
   * signed-in browser approves the short code shown by Raycast or a CLI that
   * has nowhere sensible to type a password.
   */
  plugins: [
    deviceAuthorizationClient(),
    /**
     * Adds `authClient.twoFactor.*`. No `onTwoFactorRedirect` and no
     * `twoFactorPage`: /login reads `twoFactorRedirect` off the sign-in
     * result itself, because on a native shell the right answer is an error,
     * not a page (see `isTwoFactorChallenge`).
     */
    twoFactorClient(),
  ],
  fetchOptions: {
    customFetchImpl: authFetch,
    /**
     * Names this client on every session it creates, so Settings → Devices can
     * show "Chrome on macOS" instead of an unlabelled row.
     */
    onRequest: (context) => {
      context.headers.set("x-trackyourtime-client", clientHeader());
      // Stamps the release on the session this sign-in creates, for
      // Settings → Devices.
      for (const [name, value] of Object.entries(versionHeaders(APP_VERSION))) {
        context.headers.set(name, value);
      }
      return context;
    },
    /**
     * The native shells have no cookie jar. `token` returning `undefined`
     * omits the header entirely (@better-fetch/fetch src/auth.ts), so the web
     * request is byte-identical to what it was before this existed.
     */
    auth: {
      type: "Bearer",
      token: () => getNativeToken() ?? undefined,
    },
    /**
     * Capture the session token the bearer plugin hands back.
     *
     * Guarded on truthiness on purpose: the plugin only emits
     * `set-auth-token` when the response actually carries a session cookie
     * with a non-zero max-age, so a plain `/get-session` that needs no
     * refresh emits nothing. Writing `headers.get(...)` unconditionally would
     * store `null` over a perfectly good token and sign the user out on the
     * next cold launch.
     */
    onSuccess: async (context) => {
      const issued = context.response.headers.get("set-auth-token");
      if (issued) await setNativeToken(issued);
    },
  },
});

// Re-export commonly used methods.
//
// `getSession` matters after sign-in and sign-up: it refreshes better-auth's
// session store before the app navigates. Without it the protected layout can
// read a still-empty session, decide the user is not authenticated, and bounce
// them straight back to /login even though the cookie was set correctly.
export const { signIn, signUp, useSession, getSession } = authClient;

/**
 * Things only a module that is not this one can forget — the timer store in
 * `hooks/use-sync.ts`, say, which imports this file and so cannot be imported
 * by it. Each runs once per sign-out, after the account is gone.
 */
const signOutCleanups = new Set<() => void | Promise<void>>();

export const onSignOut = (cleanup: () => void | Promise<void>): (() => void) => {
  signOutCleanups.add(cleanup);
  return () => {
    signOutCleanups.delete(cleanup);
  };
};

/**
 * Forget what this tab and device hold about the departing account, apart
 * from its offline queue (see `sealOfflineQueueOwner` / the deletion path).
 *
 * Sign-out does not reload the page. Before this, signing out and signing in
 * as someone else in the same tab showed the previous account's cached
 * entries until each query happened to refetch, its running timer until
 * `entries.current` answered — never, offline — and on a phone seeded that
 * timer again at the next cold launch from the mirror. The workspace choice
 * and membership list go too: the next account must neither send the
 * previous one's workspace id nor be shown its workspace names.
 *
 * Every step is settled independently; a cleanup that throws must not keep
 * the others from running, or leave a sign-out half done.
 */
const forgetAccountOnDevice = async (): Promise<void> => {
  await Promise.allSettled([
    writeRunningMirror(null),
    clearActiveWorkspace(),
    ...[...signOutCleanups].map(async (cleanup) => cleanup()),
  ]);
  await clearAppQueryCache().catch(() => undefined);
};

/**
 * Sign out, and forget the native token with it.
 *
 * Wrapped rather than left to each call site: on native the server-side
 * session going away is only half of it — a token left in the Keychain would
 * be re-read on the next launch and keep the app "signed in" against a
 * session that no longer exists, which is exactly the state the offline queue
 * cannot recover from.
 *
 * `sealOfflineQueueOwner()` is the other half, and this is the only place it
 * belongs: an explicit sign-out is the one moment the device knows it has
 * stopped being this person's. A `null` session anywhere else means "not
 * resolved yet", which on a cold offline launch is routine. It stamps whatever
 * is still unowned with the departing account and then forgets them — the
 * QUEUE is left alone, deliberately, because those rows are time no server has
 * ever seen.
 */
export const signOut: typeof authClient.signOut = async (...args) => {
  try {
    return await authClient.signOut(...args);
  } finally {
    // Both run whatever the server said: a sign-out the network never
    // delivered still means this person is done with this device.
    await sealOfflineQueueOwner();
    await clearNativeToken();
    await forgetAccountOnDevice();
  }
};

/** Why a deletion was refused, in the terms the settings dialog acts on. */
export type AccountDeletionRefusal =
  /** A password account sent none — ask for it. */
  | "password-required"
  /** The password was wrong. */
  | "invalid-password"
  /** An account with no password whose session is over a day old — sign in again. */
  | "session-expired"
  /** Anything else, the network included. The account still exists. */
  | "failed";

export const accountDeletionRefusal = (code: unknown): AccountDeletionRefusal => {
  switch (code) {
    case ACCOUNT_DELETION_PASSWORD_REQUIRED:
      return "password-required";
    case "INVALID_PASSWORD":
      return "invalid-password";
    case "SESSION_EXPIRED":
      return "session-expired";
    default:
      return "failed";
  }
};

/** Whether this account signs in with a password, and so confirms with one. */
export const accountHasPassword = async (): Promise<boolean> => {
  const { data, error } = await authClient.listAccounts();
  // Unknown reads as "yes": asking for a password the server then turns out
  // not to need costs a retry, while not asking for one it needs costs a
  // refusal with nowhere to type the answer.
  if (error || !Array.isArray(data)) return true;
  return data.some((account) => account.providerId === "credential");
};

/**
 * Delete the signed-in account, then forget it on this device.
 *
 * The server does the deleting — `POST /api/auth/delete-user`, which takes the
 * bearer token like every other auth call, so the native shells need nothing
 * special. What only this device can do happens after it answers, and only
 * when it answered yes:
 *
 *  - the offline queue drops the deleted account's rows. Sign-out keeps them,
 *    because that person can sign back in and send them; a deleted account
 *    cannot, and they must never be replayed under whoever signs in next;
 *  - the running-timer mirror is cleared, or the next cold launch would seed
 *    a timer belonging to an account that no longer exists;
 *  - the Keychain token goes, exactly as on sign-out.
 *
 * On a refusal nothing local is touched: the account still exists and so does
 * everything it queued.
 */
export const deleteAccount = async (args: {
  userId: string;
  password?: string;
}): Promise<{ ok: true } | { ok: false; reason: AccountDeletionRefusal }> => {
  try {
    const { error } = await authClient.deleteUser(
      args.password ? { password: args.password } : {},
    );
    if (error) return { ok: false, reason: accountDeletionRefusal(error.code) };
  } catch {
    return { ok: false, reason: "failed" };
  }

  // The account is gone whatever happens below; a local cleanup that throws
  // must not report the deletion as failed.
  await Promise.allSettled([
    discardDeletedAccountQueue(args.userId),
    writeRunningMirror(null),
  ]);
  await clearNativeToken().catch(() => undefined);
  await forgetAccountOnDevice();
  return { ok: true };
};

/**
 * Whether a sign-in answered with a second-factor challenge instead of a
 * session. better-auth's result type does not carry the field, so it is read
 * structurally.
 */
export const isTwoFactorChallenge = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;

/**
 * Where a link in a mail (verification, change of email) or a Google
 * redirect should land. The API is a different origin from the web app, so a
 * relative path would be resolved against the API and land on its 404.
 */
export const webCallbackUrl = (path: string): string =>
  typeof window === "undefined" ? path : `${window.location.origin}${path}`;

/** Where a freshly authenticated user lands. */
export const POST_AUTH_REDIRECT = "/app/track";
