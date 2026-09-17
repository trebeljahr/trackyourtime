/*
 * The one app window: remembered bounds, a background that matches the theme
 * before the page paints, and hide-on-close on macOS.
 */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, nativeTheme, screen } from "electron";

import {
  MIN_SIZE,
  backgroundColorFor,
  initialBounds,
  parseWindowState,
  type WindowState,
} from "./window-state.ts";

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

function statePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function readWindowState(): WindowState {
  try {
    return parseWindowState(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeWindowState(patch: WindowState): void {
  try {
    const next = { ...readWindowState(), ...patch };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next), "utf8");
  } catch (err) {
    console.warn("[window-state] save failed:", err);
  }
}

export function createMainWindow(options: {
  preload: string;
  dev: boolean;
  /** Tests and agents: never shown, never focused (see headless.ts). */
  headless?: boolean;
}): BrowserWindow {
  const isMac = process.platform === "darwin";
  const saved = readWindowState();
  const bounds = initialBounds(
    saved.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  );

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: "Track Your Time",
    // The page's first frame is painted over this colour, and until then the
    // window is not shown at all (`show: false` + ready-to-show). A white
    // default was a white flash for every dark-mode launch.
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    show: false,
    // macOS: no title bar; the traffic lights sit inside the web header, which
    // is the drag region (styles/desktop.css). y centres them in its 3.5rem.
    ...(isMac
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 20 } }
      : { autoHideMenuBar: true }),
    fullscreen: saved.fullscreen === true,
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: options.dev,
      spellcheck: true,
      // A hidden window is throttled like a background tab; headless runs
      // still need its timers and its paint.
      ...(options.headless ? { backgroundThrottling: false } : {}),
    },
    ...(options.headless ? { skipTaskbar: true } : {}),
  });

  if (saved.maximized) win.maximize();

  win.once("ready-to-show", () => {
    if (!win.isDestroyed() && !options.headless) win.show();
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeWindowState({
        // Normal bounds, so a maximised window restores to its old size.
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen() || win.isSimpleFullScreen(),
      });
    }, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
    win.on(event as "resize", saveSoon);
  }

  win.on("close", (event) => {
    if (saveTimer) clearTimeout(saveTimer);
    writeWindowState({
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen() || win.isSimpleFullScreen(),
    });
    // macOS: closing the window hides it and the app keeps running (the Dock
    // icon brings it back), so the renderer — which owns the socket, the
    // offline queue and the running timer — stays alive. Windows and Linux
    // quit on close until the tray exists (Stage 4): a hidden window with no
    // tray would be an app nobody can reach or quit.
    if (isMac && !quitting) {
      event.preventDefault();
      if (win.isFullScreen()) {
        win.once("leave-full-screen", () => win.hide());
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });

  return win;
}

export function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
