import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { isNative } from "@/mobile/bridge";
import {
  clearNativeToken,
  getNativeToken,
  setNativeToken,
} from "@/lib/native-session";
import { sealOfflineQueueOwner } from "@/lib/offline";

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
const clientHeader = (): string => (isNative() ? "tracktime-mobile" : "web");

export const authClient = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
  /**
   * Adds `authClient.device.*`, which backs /device — the page where a
   * signed-in browser approves the short code shown by Raycast or a CLI that
   * has nowhere sensible to type a password.
   */
  plugins: [deviceAuthorizationClient()],
  fetchOptions: {
    /**
     * Names this client on every session it creates, so Settings → Devices can
     * show "Chrome on macOS" instead of an unlabelled row.
     */
    onRequest: (context) => {
      context.headers.set("x-tracktime-client", clientHeader());
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
  }
};

/** Where a freshly authenticated user lands. */
export const POST_AUTH_REDIRECT = "/track";
