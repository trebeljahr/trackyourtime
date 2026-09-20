/*
 * `window.electronAPI`, as the Electron preload exposes it.
 *
 * The type lives in `@starter/shared` (desktop-bridge.ts) and is imported by
 * `electron/src/preload.ts` too, so the two cannot drift. Guard every usage —
 * the same build also runs in the browser, the PWA and the Capacitor shells,
 * where `window.electronAPI` is undefined.
 */

import type { DesktopBridge, DesktopIdlePayload } from "@starter/shared";

export type ElectronAPI = DesktopBridge;
export type { DesktopIdlePayload };

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}
