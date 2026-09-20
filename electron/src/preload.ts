/*
 * Electron preload — exposes a narrow `window.electronAPI` to the renderer.
 *
 * Runs sandboxed: only `electron`'s renderer modules are available, which is
 * why esbuild bundles this file. The object's shape is `DesktopBridge` from
 * `@starter/shared`, the same type the client declares on `Window`, so the two
 * cannot disagree. Every call is checked again in the main process (ipc.ts):
 * the preload is per window, not per URL.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_IPC,
  type DesktopBridge,
  type DesktopIdlePayload,
} from "../../packages/shared/src/desktop-bridge.ts";

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,

  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),

  setFullscreen: (on) => ipcRenderer.invoke(DESKTOP_IPC.setFullscreen, on),
  isFullscreen: () => ipcRenderer.invoke(DESKTOP_IPC.isFullscreen),

  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),

  getIdleState: () => ipcRenderer.invoke(DESKTOP_IPC.getIdle),

  /*
   * The listener is wrapped so the renderer never receives the
   * IpcRendererEvent, which would leak `sender` across the context bridge.
   */
  onIdleState: (listener) => {
    const handler = (_event: unknown, payload: DesktopIdlePayload): void => listener(payload);
    ipcRenderer.on(DESKTOP_IPC.idleState, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC.idleState, handler);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", bridge);
