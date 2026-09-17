"use client";

/**
 * The token shells' session credential — the phone apps and the desktop app.
 *
 * A `capacitor://localhost` document is cross-site to the API no matter what
 * SameSite says, and WKWebView's tracking prevention drops the cookie anyway.
 * An `app://-` document (the desktop app) is cross-site to the API in exactly
 * the same way. So both shells use the same path Raycast and the browser
 * extension use: sign in normally, keep the better-auth **session token**, and send it
 * as `Authorization: Bearer <token>` (and as the `bearer.<token>` WebSocket
 * subprotocol). There is no second credential type and no server change —
 * `packages/core/src/session-auth.ts` documents the whole contract.
 *
 * Three things this module is careful about:
 *
 *  - **It is inert on web.** Every export short-circuits when `isTokenShell()`
 *    is false, and nothing here imports a Capacitor package at module scope,
 *    so the web bundle never pulls one in.
 *
 *  - **The token lives in real secret storage**, behind one
 *    {@link SecureTokenStore}. On the phone that is the Keychain, via
 *    `@aparajita/capacitor-secure-storage` — not `@capacitor/preferences`,
 *    which is plain UserDefaults and readable from an unencrypted device
 *    backup. In the desktop app it is `window.electronAPI.secureStore`: the
 *    main process encrypts it with Electron's `safeStorage` into
 *    `userData/session.bin` (`electron/src/secure-store.ts`), and refuses to
 *    write it at all where that would not really be encryption.
 *
 *  - **Keychain items outlive the app.** iOS does not clear an app's Keychain
 *    on delete, so a reinstall would silently resume the previous session —
 *    including a previous *user's* session on a handed-down device. Preferences
 *    *is* wiped on delete, so a marker written there tells a fresh install from
 *    a relaunch, and a fresh install starts signed out. See
 *    `enforceFreshInstall()`. Phone only: a removed desktop app leaves
 *    `session.bin` and its key's profile together, so they agree.
 *
 * Readiness is published as a store rather than gating the React tree: under
 * `output: "export"` every page is prerendered in Node, where
 * `isTokenShell()` is false, so a component that renders `null` while hydrating would disagree
 * with the served HTML and force React to throw the whole subtree away. The
 * consumers — `ProtectedLayout`'s recheck and `useSync`'s socket — wait on
 * the flag instead. Same rule the tab bar follows.
 */

import { isCapacitor, isElectron, isTokenShell } from "@/lib/shell";
import { hydrateApiOrigin } from "@/lib/api-origin";

/** Keychain item holding the better-auth session token. */
const TOKEN_KEY = "trackyourtime.session-token";

/**
 * Preferences marker proving this install has run before. Preferences is
 * wiped when the app is deleted; the Keychain is not.
 */
const INSTALL_MARKER_KEY = "trackyourtime.installed";

// ── the store ────────────────────────────────────────────────────────

type Listener = () => void;

export type NativeSession = {
  /** The bearer token, or null on web and while signed out. */
  token: string | null;
  /** True once hydration has settled. Always true on web. */
  ready: boolean;
};

const listeners = new Set<Listener>();

let token: string | null = null;
let ready = false;
// Rebuilt only when something changes, so `useSyncExternalStore` sees a
// stable reference and does not re-render on every check.
let snapshot: NativeSession = { token: null, ready: false };

const publish = (): void => {
  snapshot = { token, ready };
  for (const listener of listeners) listener();
};

export const subscribeNativeSession = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getNativeSession = (): NativeSession => snapshot;

const SERVER_SNAPSHOT: NativeSession = { token: null, ready: false };

/**
 * Prerender/SSR snapshot. `ready: false` matches the client's first snapshot
 * on both platforms, so nothing that reads this can differ between the served
 * HTML and hydration.
 */
export const getServerNativeSession = (): NativeSession => SERVER_SNAPSHOT;

/** Synchronous read for non-React callers (tRPC headers, the socket URL). */
export const getNativeToken = (): string | null => token;

/** True once `hydrateNativeSession()` has settled. */
export const isNativeSessionReady = (): boolean => ready;

// ── secure storage, loaded only in a token shell ─────────────────────

/** Where the one session token is kept. One per shell, chosen at first use. */
export type SecureTokenStore = {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
};

let secureStorePromise: Promise<SecureTokenStore | null> | null = null;

/**
 * The desktop app's store: the bridge the preload exposes. Only one token
 * exists, so there is no key to pass across IPC.
 */
const electronTokenStore = (): SecureTokenStore | null => {
  const store = window.electronAPI?.secureStore;
  if (!store) return null;
  return {
    get: () => store.getToken(),
    set: async (next) => {
      await store.setToken(next);
    },
    delete: () => store.deleteToken(),
  };
};

const loadSecureStore = async (): Promise<SecureTokenStore | null> => {
  if (!isTokenShell()) return null;
  if (isElectron()) {
    secureStorePromise ??= Promise.resolve(electronTokenStore());
    return secureStorePromise;
  }
  secureStorePromise ??= (async () => {
    try {
      const { SecureStorage } = await import(
        "@aparajita/capacitor-secure-storage"
      );

      // A session credential has no business riding iCloud Keychain to the
      // user's other devices — each device signs in and gets its own row in
      // Settings → Devices, which is the whole point of the devices list.
      try {
        await SecureStorage.setSynchronize(false);
      } catch {
        /* older platform versions refuse; the default is already false */
      }

      /*
       * Wrapped, never returned as-is.
       *
       * A Capacitor plugin handle is a Proxy that answers EVERY property with
       * a callable — `then` included. Returning it from an `async` function
       * therefore makes the promise machinery treat it as a thenable and call
       * `SecureStorage.then(resolve, reject)`, which dispatches a bridge
       * message for a native method named "then" that no plugin implements.
       * Nothing rejects, nothing resolves, and hydration hangs forever behind
       * a splash screen configured never to auto-hide. Cost us an afternoon;
       * a plain object with three bound methods costs nothing.
       */
      return {
        get: () => SecureStorage.getItem(TOKEN_KEY),
        set: (value: string) => SecureStorage.setItem(TOKEN_KEY, value),
        delete: () => SecureStorage.removeItem(TOKEN_KEY),
      };
    } catch {
      // A build that dropped the plugin (the SPM sync does that silently for a
      // plugin with no Package.swift) must not take the app down with it —
      // `scripts/build-mobile.mjs` is where that is supposed to be caught.
      return null;
    }
  })();
  return secureStorePromise;
};

// ── fresh-install detection ──────────────────────────────────────────

/**
 * Wipe a Keychain token left behind by a previous install.
 *
 * Deleting an iOS app leaves its Keychain items in place, so without this a
 * reinstall resumes whatever session was last stored — a genuine auth
 * boundary failure on a shared or handed-down device. `@capacitor/preferences`
 * lives in the app container and *is* deleted, so its marker is the honest
 * "has this install run before" signal.
 */
const enforceFreshInstall = async (store: SecureTokenStore): Promise<void> => {
  if (!isCapacitor()) return;
  const { Preferences } = await import("@capacitor/preferences");
  const { value } = await Preferences.get({ key: INSTALL_MARKER_KEY });
  if (value) return;

  await store.delete().catch(() => undefined);
  await Preferences.set({ key: INSTALL_MARKER_KEY, value: "1" });
};

// ── hydration ────────────────────────────────────────────────────────

let hydration: Promise<void> | null = null;

/**
 * How long the launch path will wait for the Keychain.
 *
 * Every consumer of this module holds its render until hydration settles, so
 * a call that never comes back is a permanently frozen app — the splash does
 * not auto-hide, and there is no console on a device build. Nothing here is
 * expected to take even a hundred milliseconds; the deadline exists so that
 * a plugin which stops answering degrades to "signed out" instead of "dead".
 */
const HYDRATE_TIMEOUT_MS = 5000;

const readStoredToken = async (): Promise<void> => {
  try {
    const store = await loadSecureStore();
    if (!store) return;
    await enforceFreshInstall(store);
    const stored = await store.get();
    token = stored && stored.length > 0 ? stored : null;
  } catch {
    // An unreadable Keychain (locked device, a corrupted item) is "signed
    // out", never a crash on the launch path.
    token = null;
  }
};

const runHydration = async (): Promise<void> => {
  if (!isTokenShell()) {
    ready = true;
    publish();
    return;
  }

  // The read keeps going after the deadline; if it eventually answers with a
  // token, `publish()` hands it to consumers that key on it.
  //
  // The server choice is read in the same gate. Everything that waits on
  // `ready` — the protected layout's session check, the sync socket — is about
  // to talk to a server, and must know WHICH one before it does.
  const read = Promise.all([readStoredToken(), hydrateApiOrigin()]).then(() => {
    if (ready) publish();
  });

  await Promise.race([
    read,
    new Promise<void>((resolve) => {
      setTimeout(resolve, HYDRATE_TIMEOUT_MS);
    }),
  ]);

  ready = true;
  publish();
};

/**
 * Read the stored token. Idempotent and safe to call from several mounts —
 * the first call owns the work and the rest await the same promise.
 */
export const hydrateNativeSession = (): Promise<void> => {
  hydration ??= runHydration();
  return hydration;
};

// ── writes ───────────────────────────────────────────────────────────

/**
 * Store a freshly issued session token.
 *
 * Callers must never hand this a falsy value: better-auth's bearer plugin
 * only emits `set-auth-token` when the response actually carries a session
 * cookie, so most authenticated calls have no header at all — writing what
 * `headers.get()` returned unconditionally would erase a good token on the
 * first `/get-session` and sign the user out on the next launch.
 */
export const setNativeToken = async (next: string): Promise<void> => {
  if (!isTokenShell()) return;
  if (!next) return;

  token = next;
  publish();

  const store = await loadSecureStore();
  await store?.set(next).catch(() => undefined);
};

/** Forget the token — sign-out, or a session the server no longer knows. */
export const clearNativeToken = async (): Promise<void> => {
  if (!isTokenShell()) return;

  token = null;
  publish();

  const store = await loadSecureStore();
  await store?.delete().catch(() => undefined);
};

/**
 * Test seam. Resets the module back to its pre-hydration state so a spec can
 * drive hydration more than once in one process.
 */
export const __resetNativeSessionForTests = (): void => {
  token = null;
  ready = false;
  hydration = null;
  secureStorePromise = null;
  snapshot = { token: null, ready: false };
};
