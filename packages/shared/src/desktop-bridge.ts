/**
 * The contract between the Electron shell and the web app it hosts.
 *
 * `electron/src/preload.ts` builds a `DesktopBridge` and exposes it as
 * `window.electronAPI`; `packages/client/src/types/electron.d.ts` declares the
 * same type on `Window`. Both import it from here, so the object the preload
 * hands over and the object the renderer calls cannot drift apart without a
 * type error on one side.
 *
 * Types and string constants only: the preload is bundled into a sandboxed
 * script, and the renderer loads this through `@starter/shared`, so nothing in
 * this file may touch Node, Electron or the DOM.
 */

/** The OS platforms the shell reports, as Node's `process.platform` spells them. */
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** What the main process reports about the machine's idleness. */
export interface DesktopIdlePayload {
  /** "active" | "idle" | "locked" — widened because it crosses IPC. */
  state: string;
  /** Seconds since the OS last saw any input. */
  idleSeconds: number;
}

/**
 * Where the session token is kept, as the main process reports it.
 *
 * `persistent: false` means the token lives in the main process's memory only
 * and the next launch starts signed out: Electron's `safeStorage` had no real
 * encryption to offer (Linux with no keyring, where the backend is
 * `basic_text` — obfuscation with a hardcoded key). Writing a credential there
 * would look secure and not be, so the app refuses and says so instead.
 */
export interface DesktopSecureStoreStatus {
  persistent: boolean;
  /**
   * `safeStorage.getSelectedStorageBackend()` on Linux ("gnome_libsecret",
   * "kwallet5", "basic_text", …); "keychain" on macOS, "dpapi" on Windows,
   * "unavailable" when encryption is not available at all.
   */
  backend: string;
}

/**
 * The session token store, backed by `safeStorage` in the main process. The
 * renderer never sees the file or the key; it hands a token over and asks
 * for it back.
 */
export interface DesktopSecureStore {
  getToken: () => Promise<string | null>;
  setToken: (token: string) => Promise<DesktopSecureStoreStatus>;
  deleteToken: () => Promise<void>;
  status: () => Promise<DesktopSecureStoreStatus>;
}

/**
 * `window.electronAPI`. Guard every use: the same export also runs in a
 * browser, an installed PWA and the Capacitor shells, where it is undefined.
 */
export interface DesktopBridge {
  isDesktop: true;
  /**
   * The OS, known synchronously so the pre-paint script can put it on
   * `<html data-platform>` before the first frame (the macOS traffic-light
   * inset depends on it). Widened to `string` for platforms Electron supports
   * and this app does not style.
   */
  platform: DesktopPlatform | (string & {});
  quit: () => Promise<void>;
  setFullscreen: (on: boolean) => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;

  /**
   * OS-level idle, which sees input in every application — a renderer only
   * sees its own. Optional so a caller keeps guarding on it.
   */
  getIdleState?: () => Promise<DesktopIdlePayload>;
  onIdleState?: (listener: (payload: DesktopIdlePayload) => void) => () => void;

  /** The bearer session token's home (Stage 2). */
  secureStore: DesktopSecureStore;
}

/**
 * Every IPC channel name, in one place. The main process registers handlers
 * under these and the preload invokes them, so a rename is one edit.
 */
export const DESKTOP_IPC = {
  quit: "app:quit",
  openExternal: "app:openExternal",
  setFullscreen: "window:setFullscreen",
  isFullscreen: "window:isFullscreen",
  getIdle: "idle:get",
  tokenGet: "secure-store:get",
  tokenSet: "secure-store:set",
  tokenDelete: "secure-store:delete",
  tokenStatus: "secure-store:status",
  /** main → renderer push, not an invoke. */
  idleState: "idle:state",
} as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC];

/**
 * The origin the packaged app serves its export from. A constant on purpose:
 * `localStorage`, the offline queue and every server's trust list are keyed by
 * origin, so changing the scheme or host after a release orphans all of them.
 */
export const DESKTOP_APP_SCHEME = "app";
export const DESKTOP_APP_HOST = "-";
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}` as const;
