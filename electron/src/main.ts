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
import { app, BrowserWindow, safeStorage } from "electron";

import { DESKTOP_APP_ORIGIN, DESKTOP_IPC } from "../../packages/shared/src/desktop-bridge.ts";
import { installActivity, type ActivityController } from "./activity/install.ts";
import { DESKTOP_TEST_HOOK, installDesktop, type DesktopController, type DesktopTestHook } from "./desktop.ts";
import { distributionChannel } from "./distribution.ts";
import { openInOs } from "./external.ts";
import { isHeadless } from "./headless.ts";
import { onIdleChange, startIdleMonitor } from "./idle.ts";
import { configureIpcTrust, handle } from "./ipc.ts";
import { isHiddenLaunch } from "./login-item.ts";
import { installApplicationMenu } from "./menu.ts";
import { userDataDir } from "./profile.ts";
import { handleAppScheme, registerAppScheme } from "./protocol.ts";
import { createSecureStore, platformBackend, sessionFileAt, type SecureStore } from "./secure-store.ts";
import { installSecurity } from "./security.ts";
import { isExternalWebUrl } from "./trust.ts";
import { createMainWindow, revealWindow } from "./window.ts";

/*
 * A packaged app ignores ELECTRON_DEV_URL: honoring it would let anything that
 * can set an environment variable load an arbitrary page with the bridge.
 */
const devUrl = !app.isPackaged && process.env.ELECTRON_DEV_URL ? process.env.ELECTRON_DEV_URL : null;
const isDev = devUrl !== null;

/*
 * The profile directory (profile.ts): pinned by name, separate for unpackaged
 * runs, and movable with TRACKYOURTIME_USER_DATA_DIR for the e2e harness or a
 * second copy on purpose. It carries the single-instance lock, which is why it
 * has to be set before the lock is requested.
 */
app.setPath(
  "userData",
  userDataDir({
    appData: app.getPath("appData"),
    isPackaged: app.isPackaged,
    // Never the installed app's profile: headless runs on the mock keychain,
    // where that profile's session.bin cannot decrypt (profile.ts).
    headless: isHeadless(),
    override: process.env.TRACKYOURTIME_USER_DATA_DIR,
  }),
);

/*
 * Headless (tests, agents): never show, focus or activate anything. On macOS
 * the accessory policy keeps the app out of the Dock and stops launch from
 * activating it; it is set before ready so the first frame never activates.
 */
const headless = isHeadless();
if (headless && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  /*
   * And no Keychain. Chromium's OSCrypt (cookie encryption, and safeStorage
   * behind the session token) otherwise reads or creates "<name> Safe
   * Storage" in the login keychain, and macOS may answer a binary whose
   * signature differs from the item's creator (a rebuilt ad-hoc signed app)
   * with a system password prompt, which takes focus. The mock keychain is a
   * fixed in-process key: encryption still round-trips, so a headless run
   * exercises the same store, but its ciphertext is only readable by another
   * headless run. Measured: with the switch no Keychain item is created, and
   * without it one is.
   */
  app.commandLine.appendSwitch("use-mock-keychain");
}

/*
 * One instance per profile. Two would each hold a socket and both write the
 * same localStorage offline queue. A second launch hands over to the first
 * (which comes to the front) and exits.
 */
if (!app.requestSingleInstanceLock()) {
  console.log(`[main] another instance holds ${app.getPath("userData")}; handing over to it`);
  app.exit(0);
} else {
  start();
}

function start(): void {
  if (process.platform === "win32") app.setAppUserModelId("com.ricoslabs.trackyourtime");

  registerAppScheme();
  installSecurity({ devUrl });
  configureIpcTrust({ devUrl });

  /** electron/dist → the repo root, or the root of app.asar when packaged. */
  const appRoot = path.join(__dirname, "..", "..");
  const exportDir = path.join(appRoot, "packages", "client", "out-desktop");
  const preload = path.join(__dirname, "preload.js");

  let mainWindow: BrowserWindow | null = null;
  /** Tray, shortcuts, desktop settings, notifications (desktop.ts); set once ready. */
  let desktop: DesktopController | null = null;
  /** Activity capture (activity/install.ts); set once ready. */
  let activity: ActivityController | null = null;

  const showMain = (): void => {
    if (headless) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      revealWindow(mainWindow);
    } else if (app.isReady()) {
      mainWindow = openWindow();
    }
  };

  // A login-item launch while the app already runs changes nothing on screen.
  app.on("second-instance", (_event, argv) => {
    if (!isHiddenLaunch(argv)) showMain();
  });

  handle(DESKTOP_IPC.quit, () => {
    app.quit();
  });

  /*
   * The session token (secure-store.ts). Created on first use, which is after
   * ready: on Linux safeStorage cannot answer before then.
   */
  let secureStore: SecureStore | null = null;
  const tokens = (): SecureStore => {
    secureStore ??= createSecureStore(
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        backend: () =>
          process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : platformBackend(process.platform),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (cipher) => safeStorage.decryptString(cipher),
      },
      sessionFileAt(app.getPath("userData")),
    );
    return secureStore;
  };

  handle(DESKTOP_IPC.tokenGet, () => tokens().getToken());
  handle(DESKTOP_IPC.tokenSet, (_event, token: unknown) => {
    if (typeof token !== "string") return tokens().status();
    return tokens().setToken(token);
  });
  handle(DESKTOP_IPC.tokenDelete, () => {
    tokens().deleteToken();
  });
  handle(DESKTOP_IPC.tokenStatus, () => tokens().status());

  handle(DESKTOP_IPC.openExternal, async (_event, url: unknown) => {
    if (typeof url !== "string" || !isExternalWebUrl(url)) return false;
    try {
      await openInOs(url);
      return true;
    } catch {
      return false;
    }
  });

  function openWindow(options: { show?: boolean } = {}): BrowserWindow {
    const win = createMainWindow({
      preload,
      dev: isDev,
      headless,
      showOnReady: options.show ?? true,
      hideOnClose: () => (desktop ? desktop.hideOnClose() : process.platform === "darwin"),
    });
    // A reload or a crashed renderer cannot finish recording a shortcut.
    win.webContents.on("did-start-loading", () => desktop?.rendererReset());
    win.webContents.on("render-process-gone", () => desktop?.rendererReset());
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
    desktop = installDesktop({
      headless,
      platform: process.platform,
      userData: app.getPath("userData"),
      // Copied beside the bundle by scripts/build-desktop.mjs.
      iconDir: path.join(__dirname, "tray"),
      isPackaged: app.isPackaged,
      mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      reveal: showMain,
    });
    /*
     * Activity capture (Stage 8). Off until the person turns it on; headless
     * runs get the fake source and the test hook, never the real frontmost app.
     */
    activity = installActivity({
      headless,
      platform: process.platform,
      channel: distributionChannel({
        platform: process.platform,
        isPackaged: app.isPackaged,
        mas: process.mas === true,
        windowsStore: process.windowsStore === true,
        env: process.env,
      }),
      env: process.env,
      userData: app.getPath("userData"),
      subscribeIdle: onIdleChange,
    });
    const hook = (globalThis as Record<string, unknown>)[DESKTOP_TEST_HOOK] as DesktopTestHook | undefined;
    if (hook !== undefined && activity.testHook !== null) hook.activity = activity.testHook;

    mainWindow = openWindow({ show: !desktop.launchHidden(process.argv) });

    // macOS: the Dock icon brings back a window hidden by its close button.
    app.on("activate", showMain);
  });

  app.on("will-quit", () => {
    activity?.dispose();
    activity = null;
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
