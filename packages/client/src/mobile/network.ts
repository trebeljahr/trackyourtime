/*
 * What "online" actually means, per platform.
 *
 * `navigator.onLine` is the browser's answer and it is a good one in a
 * browser. In WKWebView it is not: it routinely reports `true` on a dead
 * radio, and it does not fire `online`/`offline` when the phone enters or
 * leaves airplane mode. Two things downstream take that lie seriously:
 *
 *  - `isNetworkError()` short-circuits to `true` when `isOnline()` is false.
 *    A lying `true` therefore makes a genuine server rejection look like a
 *    transport failure — the mutation is queued forever instead of rolled
 *    back — and a lying `false` makes a real refusal look like a hiccup.
 *  - React Query's `onlineManager` decides whether to fetch at all. Fed the
 *    browser's answer, a backgrounded phone wakes up and fires a burst of
 *    doomed requests into a radio that is not there.
 *
 * So on native the truth comes from `@capacitor/network`, which reads the
 * OS reachability API. On web nothing changes: the same `navigator.onLine`
 * plus the same `online`/`offline` events, through one subscription surface
 * so callers do not care which platform they are on.
 *
 * The plugin is imported lazily; the web bundle never pulls it in.
 */

import { isCapacitor } from "@/lib/shell";

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * The radio's answer, or `null` while we have not heard from it — which is
 * every moment on web, and the first few milliseconds of a native launch.
 * `null` is not `false`: an unknown state must fall back to the browser's
 * guess rather than declare the app offline.
 */
let nativeOnline: boolean | null = null;

let windowBound = false;
let watchStarted = false;

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** The current verdict. Native truth when we have it, the browser otherwise. */
export const getNetworkOnline = (): boolean => {
  if (nativeOnline !== null) return nativeOnline;
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
};

/** Server snapshot for `useSyncExternalStore` — nothing is offline on SSR. */
export const getServerNetworkOnline = (): boolean => true;

const bindWindow = (): void => {
  if (windowBound || typeof window === "undefined") return;
  windowBound = true;
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
};

/** Subscribe to changes in the verdict above. */
export const subscribeNetwork = (listener: Listener): (() => void) => {
  listeners.add(listener);
  bindWindow();
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Start listening to the radio. Idempotent, and a no-op on web beyond binding
 * the window events. Called from `MobileBridgeLoader`, which is the first
 * thing the root layout renders.
 */
export const startNetworkWatch = (): void => {
  if (watchStarted) return;
  watchStarted = true;
  bindWindow();
  if (!isCapacitor()) return;

  void (async () => {
    try {
      const { Network } = await import("@capacitor/network");
      const apply = (status: { connected: boolean }): void => {
        const next = status.connected !== false;
        if (next === nativeOnline) return;
        nativeOnline = next;
        notify();
      };
      // The listener goes on first: a status read that resolves after a change
      // we were not yet listening for would otherwise leave us one behind.
      await Network.addListener("networkStatusChange", apply);
      apply(await Network.getStatus());
    } catch {
      // No plugin, or a platform that refuses — `navigator.onLine` stays the
      // source and nothing above notices.
    }
  })();
};

/** Test seam: forget the radio and every listener. */
export const __resetNetworkForTests = (): void => {
  listeners.clear();
  nativeOnline = null;
  watchStarted = false;
};
