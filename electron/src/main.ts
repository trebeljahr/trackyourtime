/*
 * Electron main process for Track Your Time.
 *
 * Production (packaged, and the e2e harness): serves
 * `packages/client/out-desktop` — built by `scripts/build-desktop.mjs` — from
 * the privileged `app://-` scheme and loads `app://-/`.
 *
 * Dev (`pnpm dev:desktop`, unpackaged only): loads ELECTRON_DEV_URL, the Next
 * dev server. That origin is same-site with a local API, so cookie auth works
 * there and nowhere else — never accept a desktop change on dev alone.
 *
 * Bundled by esbuild into electron/dist/main.js; the modules beside this file
 * are split by concern (protocol, window, ipc, idle, menu, security).
 */

import path from "node:path";
import { app, BrowserWindow, shell } from "electron";

import { DESKTOP_APP_ORIGIN, DESKTOP_IPC } from "../../packages/shared/src/desktop-bridge.ts";
import { isHeadless } from "./headless.ts";
import { startIdleMonitor } from "./idle.ts";
import { configureIpcTrust, handle } from "./ipc.ts";
import { installApplicationMenu } from "./menu.ts";
import { handleAppScheme, registerAppScheme } from "./protocol.ts";
import { installSecurity } from "./security.ts";
import { isExternalWebUrl } from "./trust.ts";
import { createMainWindow, revealWindow, writeWindowState } from "./window.ts";

/*
 * A packaged app ignores ELECTRON_DEV_URL: honoring it would let anything that
 * can set an environment variable load an arbitrary page with the bridge.
 */
const devUrl = !app.isPackaged && process.env.ELECTRON_DEV_URL ? process.env.ELECTRON_DEV_URL : null;
const isDev = devUrl !== null;

/*
 * A separate profile directory, for the e2e harness and for running a second
 * copy on purpose. It moves the single-instance lock with it, which is why it
 * has to be applied before the lock is requested.
 */
const userDataOverride = process.env.TRACKYOURTIME_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

/*
 * Headless (tests, agents): never show, focus or activate anything. On macOS
 * the accessory policy keeps the app out of the Dock and stops launch from
 * activating it; it is set before ready so the first frame never activates.
 */
const headless = isHeadless();
if (headless && process.platform === "darwin") app.setActivationPolicy("accessory");

/*
 * One instance per profile. Two would each hold a socket and both write the
 * same localStorage offline queue. A second launch hands over to the first
 * (which comes to the front) and exits.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  start();
}

function start(): void {
  if (process.platform === "win32") app.setAppUserModelId("com.trebeljahr.trackyourtime");

  registerAppScheme();
  installSecurity({ devUrl });
  configureIpcTrust({ devUrl });

  /** electron/dist → the repo root, or the root of app.asar when packaged. */
  const appRoot = path.join(__dirname, "..", "..");
  const exportDir = path.join(appRoot, "packages", "client", "out-desktop");
  const preload = path.join(__dirname, "preload.js");

  let mainWindow: BrowserWindow | null = null;

  const showMain = (): void => {
    if (headless) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      revealWindow(mainWindow);
    } else if (app.isReady()) {
      mainWindow = openWindow();
    }
  };

  app.on("second-instance", showMain);

  handle(DESKTOP_IPC.quit, () => {
    app.quit();
  });

  handle(DESKTOP_IPC.setFullscreen, (event, wantFullscreen: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const on = wantFullscreen === true;
    win.setFullScreen(on);
    writeWindowState({ fullscreen: on });
    return on;
  });

  handle(DESKTOP_IPC.isFullscreen, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && !win.isDestroyed() && win.isFullScreen();
  });

  handle(DESKTOP_IPC.openExternal, async (_event, url: unknown) => {
    if (typeof url !== "string" || !isExternalWebUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  function openWindow(): BrowserWindow {
    const win = createMainWindow({ preload, dev: isDev, headless });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });
    if (devUrl) {
      loadDev(win, devUrl);
    } else {
      void win.loadURL(`${DESKTOP_APP_ORIGIN}/`);
    }
    return win;
  }

  app.whenReady().then(() => {
    if (headless && process.platform === "darwin") {
      app.setActivationPolicy("accessory");
      app.dock?.hide();
    }
    if (!devUrl) handleAppScheme(exportDir);
    installApplicationMenu(isDev);
    startIdleMonitor();
    mainWindow = openWindow();

    // macOS: the Dock icon brings back a window hidden by its close button.
    app.on("activate", showMain);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

function loadDev(win: BrowserWindow, url: string): void {
  void win.loadURL(url);
  win.webContents.openDevTools({ mode: "detach" });

  // Recover from transient dev-server outages during HMR restarts.
  const RECOVERABLE_ERRORS = new Set([-7, -21, -101, -102, -104, -105, -106]);
  let retrying = false;
  win.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !validatedURL.startsWith(url) || !RECOVERABLE_ERRORS.has(errorCode) || retrying) {
      return;
    }
    retrying = true;
    console.log(`[dev-reload] ${errorDescription} (${errorCode}); retrying`);
    const tryReload = (): void => {
      if (win.isDestroyed()) {
        retrying = false;
        return;
      }
      win.loadURL(url).catch(() => setTimeout(tryReload, 500));
    };
    setTimeout(tryReload, 300);
  });
  win.webContents.on("did-finish-load", () => {
    retrying = false;
  });
}
