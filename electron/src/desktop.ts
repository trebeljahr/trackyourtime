/*
 * Stages 4 and 5 of docs/desktop-app-plan.md, wired together: the tray, the
 * global shortcuts, Settings → Desktop, open at login, notifications for
 * prompts a hidden window would swallow, the running badge and the notice on
 * quitting with unsent changes. Stage 7 adds the updater's status, "Restart to
 * update" in the tray, and the IPC Settings → Desktop reads it through.
 *
 * The renderer owns the timer (the socket, the offline queue, the locale);
 * this process draws what it publishes and sends commands back. Nothing here
 * starts or stops a timer by itself.
 *
 * **Headless** (tests, agents): no tray icon, no global shortcut registered
 * with the OS, no notification posted, no dialog, no badge and no login item.
 * Each of those is recorded instead on `globalThis.__trackYourTimeDesktop`
 * (`DesktopTestHook`), which a Playwright `app.evaluate` reads and drives.
 * The updater is a memory stand-in there (updater.ts): no network, and a
 * restart is counted instead of quitting.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  nativeImage,
  Notification,
  powerMonitor,
} from "electron";

import {
  DESKTOP_IPC,
  type DesktopCommand,
  type DesktopLoginItemStatus,
  type DesktopNotice,
  type DesktopSettings,
  type DesktopSettingsSnapshot,
  type DesktopSettingsUpdate,
  type DesktopTimerState,
  type DesktopTrayLabels,
  type DesktopUpdateSnapshot,
} from "../../packages/shared/src/desktop-bridge.ts";
import type { DesktopShortcutAction } from "../../packages/shared/src/desktop-shortcuts.ts";
import { applySettingsPatch, readDesktopSettings, writeDesktopSettings } from "./desktop-settings.ts";
import { handle } from "./ipc.ts";
import {
  createLinuxLoginItem,
  createMemoryLoginItem,
  createUnsupportedLoginItem,
  HIDDEN_LAUNCH_ARG,
  type LoginItemBackend,
} from "./login-item.ts";
import { distributionChannel, loginItemMechanism } from "./distribution.ts";
import { createMemoryRegistrar, createShortcutManager, type ShortcutRegistrar } from "./shortcuts.ts";
import { createElectronTray, type TrayView } from "./tray.ts";
import { installUpdater } from "./updater.ts";
import type { UpdaterEvent } from "./updater-model.ts";
import { markQuitting } from "./window.ts";
import {
  FALLBACK_TRAY_LABELS,
  parseNotice,
  parseTimerState,
  parseTrayLabels,
  trayMenuModel,
  trayTitle,
  trayTooltip,
  type TrayMenuItem,
} from "./tray-model.ts";

export const DESKTOP_TEST_HOOK = "__trackYourTimeDesktop";

/** How long Settings may hold the shortcuts unregistered before they come back on their own. */
const SUSPEND_LIMIT_MS = 60_000;
const LABELS_FILE = "tray-labels.json";

export interface DesktopTestHook {
  state: () => DesktopTimerState | null;
  settings: () => DesktopSettings;
  trayMenu: () => TrayMenuItem[] | null;
  trayTitle: (nowMs?: number) => string;
  trayTooltip: (nowMs?: number) => string;
  clickTray: (id: string) => void;
  trigger: (action: DesktopShortcutAction) => void;
  registered: () => string[];
  /** Pretend another application holds a chord, for the next registration. */
  takeChord: (accelerator: string) => void;
  notifications: DesktopNotice[];
  clickNotification: (index: number) => void;
  /** The window counts as in front (visible and focused) for `notify`. */
  pretendFocused: (focused: boolean) => void;
  quitNotices: { title: string; body: string }[];
  badge: () => boolean;
  reveals: () => number;
  commands: DesktopCommand[];
  update: {
    snapshot: () => DesktopUpdateSnapshot;
    /** Feed an updater event, as electron-updater would. */
    dispatch: (event: UpdaterEvent) => void;
    /** How many times something asked to quit and install. */
    installs: () => number;
    checks: () => number;
  };
}

export interface DesktopController {
  /** Whether the close button should hide the window rather than quit. */
  hideOnClose: () => boolean;
  /** Whether this launch should stay in the tray without showing a window. */
  launchHidden: (argv: readonly string[]) => boolean;
  /** The renderer reloaded or crashed: give back shortcuts it had suspended. */
  rendererReset: () => void;
}

export function installDesktop(options: {
  headless: boolean;
  platform: NodeJS.Platform;
  userData: string;
  iconDir: string;
  isPackaged: boolean;
  mainWindow: () => BrowserWindow | null;
  /** Show and focus the window (a no-op headless). */
  reveal: () => void;
}): DesktopController {
  const { headless, platform, userData } = options;

  let settings: DesktopSettings = readDesktopSettings(userData, platform);
  let state: DesktopTimerState | null = null;
  let tray: TrayView | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let quitNoticeShown = false;
  let shuttingDown = false;

  /** The last labels a renderer sent, so a German tray stays German before sign-in. */
  let rememberedLabels: DesktopTrayLabels = FALLBACK_TRAY_LABELS;
  try {
    rememberedLabels = parseTrayLabels(JSON.parse(readFileSync(path.join(userData, LABELS_FILE), "utf8")));
  } catch {
    /* first launch */
  }

  // ── test hook state (headless only) ──────────────────────────────────
  const notifications: DesktopNotice[] = [];
  const quitNotices: { title: string; body: string }[] = [];
  const commands: DesktopCommand[] = [];
  let reveals = 0;
  let pretendFocused = false;
  let badgeOn = false;

  const reveal = (): void => {
    reveals += 1;
    options.reveal();
  };

  const send = (command: DesktopCommand): void => {
    commands.push(command);
    if (commands.length > 100) commands.shift();
    const win = options.mainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(DESKTOP_IPC.desktopCommand, command);
  };

  const signedIn = (): boolean => state?.signedIn === true;

  /** What the tray draws when no renderer has spoken yet: the remembered labels. */
  const drawnState = (): DesktopTimerState =>
    state ?? { signedIn: false, running: null, recents: [], unsent: 0, labels: rememberedLabels };

  // ── shortcuts ────────────────────────────────────────────────────────
  const memoryRegistrar = createMemoryRegistrar();
  const registrar: ShortcutRegistrar = headless
    ? memoryRegistrar
    : {
        register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
        unregister: (accelerator) => globalShortcut.unregister(accelerator),
      };

  const onShortcut = (action: DesktopShortcutAction): void => {
    switch (action) {
      case "toggle-timer":
        // Signed out there is no timer to toggle and nobody to ask: show the app.
        if (signedIn()) send({ kind: "toggle" });
        else reveal();
        return;
      case "new-timer":
        reveal();
        if (signedIn()) send({ kind: "compose" });
        return;
      case "toggle-window": {
        const win = options.mainWindow();
        if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
          win.hide();
        } else {
          reveal();
        }
        return;
      }
      case "open-palette":
        reveal();
        if (signedIn()) send({ kind: "open-palette" });
        return;
    }
  };

  const shortcuts = createShortcutManager(registrar, onShortcut);

  // ── open at login ────────────────────────────────────────────────────
  // Per distribution channel (distribution.ts): the Microsoft Store and
  // Flatpak have no reachable mechanism and say so in Settings.
  const loginMechanism = loginItemMechanism(
    distributionChannel({
      platform,
      isPackaged: options.isPackaged,
      mas: process.mas === true,
      windowsStore: process.windowsStore === true,
      env: process.env,
    }),
    { execPath: process.execPath, env: process.env, snapCommand: "trackyourtime" },
  );
  const loginItem: LoginItemBackend =
    headless || !options.isPackaged
      ? createMemoryLoginItem()
      : loginMechanism.kind === "unsupported"
        ? createUnsupportedLoginItem()
        : loginMechanism.kind === "xdg-autostart"
          ? createLinuxLoginItem({ exec: loginMechanism.exec, name: "Track Your Time" })
          : {
              status: (): DesktopLoginItemStatus => {
                const current = app.getLoginItemSettings(platform === "win32" ? { args: [HIDDEN_LAUNCH_ARG] } : undefined);
                if (platform === "darwin") {
                  if (current.status === "requires-approval") return "requires-approval";
                  if (current.status === "enabled") return "enabled";
                }
                return current.openAtLogin ? "enabled" : "disabled";
              },
              set: (enabled) => {
                app.setLoginItemSettings(
                  platform === "win32" ? { openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] } : { openAtLogin: enabled },
                );
              },
            };
  if (headless || !options.isPackaged) loginItem.set(settings.openAtLogin);

  const loginStatus = (): DesktopLoginItemStatus => {
    try {
      return loginItem.status();
    } catch {
      return "unsupported";
    }
  };

  // ── updates (Stage 7, updater.ts) ────────────────────────────────────
  const updates = installUpdater({
    headless,
    onChange: (current) => {
      redraw();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(DESKTOP_IPC.updateStatusChanged, current);
      }
    },
    beforeInstall: markQuitting,
  });
  const updateReady = (): boolean => updates.controller.snapshot().status.kind === "ready";

  // ── tray, badge, ticking clock ───────────────────────────────────────
  const redraw = (): void => {
    tray?.update(drawnState(), Date.now(), updateReady());
  };

  const syncTray = (): void => {
    if (!settings.showInTray || headless) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (tray === null) {
      tray = createElectronTray({
        iconDir: options.iconDir,
        platform,
        onItem: (id) => onTrayItem(id),
        onActivate: reveal,
      });
    }
    redraw();
  };

  const syncTick = (): void => {
    const wanted = tray !== null && state?.running != null;
    if (wanted && tick === null) {
      tick = setInterval(redraw, 1000);
    } else if (!wanted && tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };

  let overlayIcon: Electron.NativeImage | null = null;
  const syncBadge = (): void => {
    const want = settings.runningBadge && state?.running != null;
    if (want === badgeOn) return;
    badgeOn = want;
    if (headless) return;
    if (platform === "darwin") {
      app.dock?.setBadge(want ? "●" : "");
    } else if (platform === "win32") {
      const win = options.mainWindow();
      if (!win || win.isDestroyed()) return;
      overlayIcon ??= nativeImage.createFromPath(path.join(options.iconDir, "overlay-running.png"));
      win.setOverlayIcon(want ? overlayIcon : null, want ? drawnState().labels.runningBadge : "");
    }
  };

  const onTrayItem = (id: string): void => {
    if (id === "stop") send({ kind: "stop" });
    else if (id === "start") {
      reveal();
      send({ kind: "compose" });
    } else if (id.startsWith("continue:")) send({ kind: "continue", key: id.slice("continue:".length) });
    else if (id === "open") reveal();
    else if (id === "settings") {
      reveal();
      send({ kind: "open-settings" });
    } else if (id === "restart-to-update") updates.controller.restart();
    else if (id === "quit") app.quit();
  };

  // ── settings ─────────────────────────────────────────────────────────
  const snapshot = (): DesktopSettingsSnapshot => {
    const login = loginStatus();
    return {
      settings: { ...settings, openAtLogin: login === "enabled" || login === "requires-approval" },
      shortcuts: shortcuts.statuses(),
      shortcutsSuspended: shortcuts.isSuspended(),
      loginItem: login,
      capabilities: {
        closeHides: platform !== "darwin",
        runningBadge: platform === "darwin" || platform === "win32",
      },
    };
  };

  const broadcastSettings = (): void => {
    const current = snapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(DESKTOP_IPC.desktopSettingsChanged, current);
    }
  };

  const resumeShortcuts = (): void => {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    if (!shortcuts.isSuspended()) return;
    shortcuts.resume();
    broadcastSettings();
  };

  // ── notifications ────────────────────────────────────────────────────
  const posted = new Map<string, Notification>();
  const windowInFront = (): boolean => {
    if (headless) return pretendFocused;
    const win = options.mainWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  };
  const openPrompt = (notice: DesktopNotice): void => {
    reveal();
    send({ kind: "open-prompt", prompt: notice.kind });
  };

  // ── IPC ──────────────────────────────────────────────────────────────
  handle(DESKTOP_IPC.desktopPublishState, (_event, payload: unknown) => {
    const next = parseTimerState(payload);
    if (next === null) return;
    state = next;
    if (JSON.stringify(next.labels) !== JSON.stringify(rememberedLabels)) {
      rememberedLabels = next.labels;
      try {
        writeFileSync(path.join(userData, LABELS_FILE), JSON.stringify(next.labels), "utf8");
      } catch {
        /* a cosmetic cache */
      }
    }
    redraw();
    syncTick();
    syncBadge();
  });

  handle(DESKTOP_IPC.desktopSettingsGet, () => snapshot());

  handle(DESKTOP_IPC.desktopSettingsUpdate, (_event, patch: unknown): DesktopSettingsUpdate => {
    const { next, refused } = applySettingsPatch(settings, patch, platform);
    // Only when asked: the stored value can lag the OS (a person who removed
    // the login item in System Settings), and an unrelated change must not
    // put it back.
    const loginChanged =
      typeof (patch as { openAtLogin?: unknown } | null)?.openAtLogin === "boolean" &&
      next.openAtLogin !== snapshot().settings.openAtLogin;
    settings = next;
    try {
      writeDesktopSettings(userData, settings);
    } catch (err) {
      console.warn("[desktop] settings save failed:", err);
    }
    if (loginChanged) {
      try {
        loginItem.set(settings.openAtLogin);
      } catch (err) {
        console.warn("[desktop] login item failed:", err);
      }
    }
    shortcuts.apply(settings.shortcuts);
    syncTray();
    syncTick();
    syncBadge();
    const current = snapshot();
    broadcastSettings();
    return { snapshot: current, refused };
  });

  handle(DESKTOP_IPC.desktopSuspendShortcuts, (_event, suspended: unknown) => {
    if (suspended === true) {
      shortcuts.suspend();
      if (suspendTimer !== null) clearTimeout(suspendTimer);
      // A recorder that never says "done" (a crashed tab, a closed window)
      // must not leave the person's shortcuts off for the rest of the day.
      suspendTimer = setTimeout(resumeShortcuts, SUSPEND_LIMIT_MS);
      broadcastSettings();
    } else {
      resumeShortcuts();
    }
  });

  handle(DESKTOP_IPC.updateGetStatus, () => updates.controller.snapshot());
  handle(DESKTOP_IPC.updateCheck, () => updates.controller.check());
  // Only ever from a click on "Restart to update" (desktop-updates.tsx).
  handle(DESKTOP_IPC.updateRestart, () => updates.controller.restart());

  handle(DESKTOP_IPC.desktopShowWindow, () => {
    reveal();
  });

  handle(DESKTOP_IPC.desktopNotify, (_event, payload: unknown): boolean => {
    const notice = parseNotice(payload);
    if (notice === null || windowInFront()) return false;
    if (headless) {
      notifications.push(notice);
      return true;
    }
    if (!Notification.isSupported()) return false;
    posted.get(notice.tag)?.close();
    const notification = new Notification({ title: notice.title, body: notice.body });
    notification.on("click", () => openPrompt(notice));
    notification.on("close", () => {
      if (posted.get(notice.tag) === notification) posted.delete(notice.tag);
    });
    posted.set(notice.tag, notification);
    notification.show();
    return true;
  });

  // ── quit ─────────────────────────────────────────────────────────────
  powerMonitor.on("shutdown", () => {
    // A modal box during logout or shutdown would hold the whole session up.
    shuttingDown = true;
  });

  app.on("before-quit", () => {
    if (quitNoticeShown || shuttingDown || !state || state.unsent <= 0) return;
    quitNoticeShown = true;
    const { quitUnsentTitle: title, quitUnsentBody: body, quitUnsentButton: button } = state.labels;
    if (headless) {
      quitNotices.push({ title, body });
      return;
    }
    // Informational: quitting proceeds. The rows are in localStorage and are
    // sent the next time the app starts; nothing is dropped.
    dialog.showMessageBoxSync({ type: "info", title, message: title, detail: body, buttons: [button] });
  });

  app.on("will-quit", () => {
    updates.controller.dispose();
    shortcuts.dispose();
    tray?.destroy();
    tray = null;
    if (tick !== null) clearInterval(tick);
  });

  // ── start ────────────────────────────────────────────────────────────
  shortcuts.apply(settings.shortcuts);
  syncTray();

  if (headless) {
    const hook: DesktopTestHook = {
      state: () => state,
      settings: () => settings,
      trayMenu: () => (settings.showInTray ? trayMenuModel(drawnState(), { updateReady: updateReady() }) : null),
      trayTitle: (nowMs = Date.now()) => trayTitle(drawnState(), nowMs, platform),
      trayTooltip: (nowMs = Date.now()) => trayTooltip(drawnState(), nowMs),
      clickTray: onTrayItem,
      trigger: onShortcut,
      registered: () => [...memoryRegistrar.registered.keys()],
      takeChord: (accelerator) => {
        memoryRegistrar.taken.add(accelerator);
      },
      notifications,
      clickNotification: (index) => {
        const notice = notifications[index];
        if (notice) openPrompt(notice);
      },
      pretendFocused: (focused) => {
        pretendFocused = focused;
      },
      quitNotices,
      badge: () => badgeOn,
      reveals: () => reveals,
      commands,
      update: {
        snapshot: () => updates.controller.snapshot(),
        dispatch: (event) => updates.controller.dispatch(event),
        installs: () => updates.memory?.installs ?? 0,
        checks: () => updates.memory?.checks ?? 0,
      },
    };
    (globalThis as Record<string, unknown>)[DESKTOP_TEST_HOOK] = hook;
  }

  return {
    hideOnClose: () => platform === "darwin" || (settings.closeHides && settings.showInTray),
    launchHidden: (argv) =>
      argv.includes(HIDDEN_LAUNCH_ARG) && settings.showInTray && platform !== "darwin",
    rendererReset: resumeShortcuts,
  };
}
