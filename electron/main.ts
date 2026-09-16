/*
 * Electron main process for the Next.js starter.
 *
 * Dev: loads the Next.js dev server at http://localhost:3000.
 * Production: loads packages/client/out/index.html via file://.
 *   (Requires `output: "export"` in packages/client/next.config.ts.)
 */

import { app, BrowserWindow, ipcMain, Menu, powerMonitor, shell } from "electron";
import path from "path";
import fs from "fs";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const DEV_URL = process.env.ELECTRON_DEV_URL || "http://localhost:7130";

/*
 * Background mode: the window is shown without activating the app or taking
 * keyboard focus, so an agent (or a watch loop) relaunching Electron never
 * pulls it in front of whatever the person at the machine is typing into.
 *
 *   TRACKYOURTIME_ELECTRON_BACKGROUND=1  showInactive(), and no Dock icon on macOS
 *   TRACKYOURTIME_ELECTRON_BACKGROUND=0  normal show() even under `pnpm dev:desktop`
 *   unset                                showInactive() under `pnpm dev:desktop`
 *                                        (ELECTRON_DEV_URL set), show() otherwise
 *
 * A packaged build never sets either variable, so real users get show().
 */
const BACKGROUND_FLAG = process.env.TRACKYOURTIME_ELECTRON_BACKGROUND;
const showInBackground =
  BACKGROUND_FLAG === "1" || (BACKGROUND_FLAG !== "0" && Boolean(process.env.ELECTRON_DEV_URL));

ipcMain.handle("app:quit", () => {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy();
    } catch {
      /* already destroyed */
    }
  }
  app.quit();
});

type Prefs = { fullscreen?: boolean };
let _prefsPath = "";
function prefsPath(): string {
  if (!_prefsPath) {
    _prefsPath = path.join(app.getPath("userData"), "prefs.json");
  }
  return _prefsPath;
}
function loadPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}
function savePrefs(patch: Prefs): void {
  try {
    const current = loadPrefs();
    const next = { ...current, ...patch };
    fs.writeFileSync(prefsPath(), JSON.stringify(next), "utf8");
  } catch (err) {
    console.warn("[prefs] save failed:", err);
  }
}

ipcMain.handle(
  "window:setFullscreen",
  (evt, wantFullscreen: boolean) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return false;
    const isMac = process.platform === "darwin";
    if (isMac) {
      win.setSimpleFullScreen(!!wantFullscreen);
    } else {
      win.setFullScreen(!!wantFullscreen);
    }
    savePrefs({ fullscreen: !!wantFullscreen });
    return !!wantFullscreen;
  },
);

ipcMain.handle("window:isFullscreen", (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || win.isDestroyed()) return false;
  return process.platform === "darwin"
    ? win.isSimpleFullScreen()
    : win.isFullScreen();
});

/*
 * Idle detection.
 *
 * The renderer cannot see this. A browser tab only knows about input that
 * reaches it, so a person typing all afternoon in their editor looks idle to
 * the web app; `powerMonitor.getSystemIdleTime()` is the OS's own answer and
 * counts every application. This process therefore does the *detecting* and
 * the renderer does the *deciding* — the policy lives in @starter/core/idle,
 * shared with the browser extension.
 *
 * Nothing here pauses anything: it reports "the machine has seen no input for
 * N seconds" and lets the renderer apply the user's settings to that.
 */
type IdleState = "active" | "idle" | "locked";

/** How often the idle counter is sampled. Cheap; the call is a syscall. */
const IDLE_POLL_MS = 15_000;

let idleTimer: ReturnType<typeof setInterval> | null = null;
/** Sticky until the screen unlocks — the OS idle counter does not report it. */
let screenLocked = false;

/*
 * "Active" means input landed inside the last polling window, not that the
 * counter reads exactly zero. `getSystemIdleTime()` returns 0 only in the
 * second after a keystroke, so a poller testing for zero would report "idle"
 * at someone typing continuously — and the renderer would never see the sign
 * of life that reopens a paused entry.
 */
function readIdle(): { state: IdleState; idleSeconds: number } {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  if (screenLocked) return { state: "locked", idleSeconds };
  return {
    state: idleSeconds * 1000 >= IDLE_POLL_MS ? "idle" : "active",
    idleSeconds,
  };
}

function broadcastIdle(): void {
  const payload = readIdle();

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("idle:state", payload);
  }
}

function startIdleMonitor(): void {
  if (idleTimer !== null) return;

  // `lock-screen` and `suspend` are the deliberate walk-aways. They are
  // forwarded immediately rather than waiting for the next poll, because the
  // renderer may treat a lock as away without the threshold.
  const lock = (): void => {
    screenLocked = true;
    broadcastIdle();
  };
  const unlock = (): void => {
    screenLocked = false;
    broadcastIdle();
  };

  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("suspend", lock);
  powerMonitor.on("unlock-screen", unlock);
  powerMonitor.on("resume", unlock);

  idleTimer = setInterval(broadcastIdle, IDLE_POLL_MS);
}

ipcMain.handle("idle:get", () => readIdle());

ipcMain.handle("app:openExternal", async (_evt, url: string) => {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const prefs = loadPrefs();
  const wantFullscreen = prefs.fullscreen === true;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    fullscreen: wantFullscreen,
    simpleFullscreen: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    autoHideMenuBar: !isMac,
    backgroundColor: "#ffffff",
    show: false,
  });

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (showInBackground) win.showInactive();
    else win.show();
  });

  const handleExternal = (url: string) => {
    if (/^https?:\/\//i.test(url)) {
      const current = win.webContents.getURL();
      try {
        const target = new URL(url);
        const here = new URL(current);
        if (target.origin === here.origin) {
          return { action: "allow" as const };
        }
      } catch {
        /* malformed URL */
      }
      shell.openExternal(url).catch(() => {});
      return { action: "deny" as const };
    }
    return { action: "allow" as const };
  };
  win.webContents.setWindowOpenHandler(({ url }) => handleExternal(url));
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const target = new URL(url);
      const here = new URL(current);
      if (target.origin !== here.origin) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      /* malformed URL */
    }
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });

    // Recover from transient dev-server outages during HMR restarts.
    const RECOVERABLE_ERRORS = new Set([-7, -21, -101, -102, -104, -105, -106]);
    let retrying = false;
    win.webContents.on(
      "did-fail-load",
      (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (!validatedURL.startsWith(DEV_URL)) return;
        if (!RECOVERABLE_ERRORS.has(errorCode)) return;
        if (retrying) return;
        retrying = true;
        console.log(
          `[dev-reload] ${errorDescription} (${errorCode}); retrying`,
        );
        const tryReload = () => {
          if (win.isDestroyed()) {
            retrying = false;
            return;
          }
          win.loadURL(DEV_URL).catch(() => {
            setTimeout(tryReload, 500);
          });
        };
        setTimeout(tryReload, 300);
      },
    );
    win.webContents.on("did-finish-load", () => {
      retrying = false;
    });
  } else {
    win.loadFile(
      path.join(__dirname, "..", "packages", "client", "out", "index.html"),
    );
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (BACKGROUND_FLAG === "1" && process.platform === "darwin") {
    // A Dock icon bounces and the app activates on launch; hiding it keeps the
    // process an accessory that never comes to the front on its own.
    app.dock?.hide();
  }
  installApplicationMenu();
  // powerMonitor is only usable after the app is ready.
  startIdleMonitor();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
