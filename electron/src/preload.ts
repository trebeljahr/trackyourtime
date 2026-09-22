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
  type DesktopActivitySnapshot,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopIdlePayload,
  type DesktopSettingsSnapshot,
  type DesktopUpdateSnapshot,
} from "../../packages/shared/src/desktop-bridge.ts";

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,

  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),

  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),

  getIdleState: () => ipcRenderer.invoke(DESKTOP_IPC.getIdle),

  secureStore: {
    getToken: () => ipcRenderer.invoke(DESKTOP_IPC.tokenGet),
    setToken: (token) => ipcRenderer.invoke(DESKTOP_IPC.tokenSet, token),
    deleteToken: () => ipcRenderer.invoke(DESKTOP_IPC.tokenDelete),
    status: () => ipcRenderer.invoke(DESKTOP_IPC.tokenStatus),
  },

  desktop: {
    publishTimerState: (state) => ipcRenderer.invoke(DESKTOP_IPC.desktopPublishState, state),
    onCommand: (listener) => {
      const handler = (_event: unknown, command: DesktopCommand): void => listener(command);
      ipcRenderer.on(DESKTOP_IPC.desktopCommand, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC.desktopCommand, handler);
      };
    },
    getSettings: () => ipcRenderer.invoke(DESKTOP_IPC.desktopSettingsGet),
    updateSettings: (patch) => ipcRenderer.invoke(DESKTOP_IPC.desktopSettingsUpdate, patch),
    onSettingsChanged: (listener) => {
      const handler = (_event: unknown, snapshot: DesktopSettingsSnapshot): void => listener(snapshot);
      ipcRenderer.on(DESKTOP_IPC.desktopSettingsChanged, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC.desktopSettingsChanged, handler);
      };
    },
    suspendShortcuts: (suspended) => ipcRenderer.invoke(DESKTOP_IPC.desktopSuspendShortcuts, suspended),
    showWindow: () => ipcRenderer.invoke(DESKTOP_IPC.desktopShowWindow),
    notify: (notice) => ipcRenderer.invoke(DESKTOP_IPC.desktopNotify, notice),
    updates: {
      getStatus: () => ipcRenderer.invoke(DESKTOP_IPC.updateGetStatus),
      onStatus: (listener) => {
        const handler = (_event: unknown, snapshot: DesktopUpdateSnapshot): void => listener(snapshot);
        ipcRenderer.on(DESKTOP_IPC.updateStatusChanged, handler);
        return () => {
          ipcRenderer.removeListener(DESKTOP_IPC.updateStatusChanged, handler);
        };
      },
      check: () => ipcRenderer.invoke(DESKTOP_IPC.updateCheck),
      restart: () => ipcRenderer.invoke(DESKTOP_IPC.updateRestart),
    },
  },

  /*
   * Activity capture (Stage 8). Suggestions are composed in the main process;
   * no raw segment is ever handed to the page.
   */
  activity: {
    snapshot: () => ipcRenderer.invoke(DESKTOP_IPC.activitySnapshot),
    onChanged: (listener) => {
      const handler = (_event: unknown, snapshot: DesktopActivitySnapshot): void => listener(snapshot);
      ipcRenderer.on(DESKTOP_IPC.activityChanged, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC.activityChanged, handler);
      };
    },
    updateSettings: (patch) => ipcRenderer.invoke(DESKTOP_IPC.activitySettings, patch),
    setScope: (scope) => ipcRenderer.invoke(DESKTOP_IPC.activityScope, scope),
    forget: () => ipcRenderer.invoke(DESKTOP_IPC.activityForget),
    wipe: () => ipcRenderer.invoke(DESKTOP_IPC.activityWipe),
    suggestions: (input) => ipcRenderer.invoke(DESKTOP_IPC.activitySuggestions, input),
    checkAccept: (input) => ipcRenderer.invoke(DESKTOP_IPC.activityCheckAccept, input),
    markAccepted: (span) => ipcRenderer.invoke(DESKTOP_IPC.activityAccepted, span),
    dismiss: (span) => ipcRenderer.invoke(DESKTOP_IPC.activityDismiss, span),
    addRule: (rule) => ipcRenderer.invoke(DESKTOP_IPC.activityRuleAdd, rule),
    removeRule: (id) => ipcRenderer.invoke(DESKTOP_IPC.activityRuleRemove, id),
  },

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
