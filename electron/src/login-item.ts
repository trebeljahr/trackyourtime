/*
 * Open at login.
 *
 * macOS and Windows go through `app.setLoginItemSettings`. Linux has no such
 * API in Electron, so the app writes the XDG autostart entry itself:
 * `~/.config/autostart/trackyourtime.desktop`, pointing at the AppImage when
 * it runs from one (`$APPIMAGE`: `process.execPath` is inside a mount that
 * disappears on exit).
 *
 * A launch the OS started at login gets `--hidden` (Windows and Linux) and
 * opens to the tray without a window, when the tray is on. macOS 13 and
 * later register through SMAppService, which passes no arguments and does not
 * report `wasOpenedAtLogin` reliably, so a Mac opens its window at login; its
 * close button hides it.
 *
 * Headless and unpackaged runs never touch the OS: registering
 * `node_modules/electron`'s binary as a login item on somebody's machine
 * from a test would outlive the test. They get `createMemoryLoginItem`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DesktopLoginItemStatus } from "../../packages/shared/src/desktop-bridge.ts";

export const HIDDEN_LAUNCH_ARG = "--hidden";
export const LINUX_AUTOSTART_FILE = "trackyourtime.desktop";

export interface LoginItemBackend {
  status: () => DesktopLoginItemStatus;
  set: (enabled: boolean) => void;
}

export function createMemoryLoginItem(): LoginItemBackend & { enabled: boolean } {
  const item = {
    enabled: false,
    status: (): DesktopLoginItemStatus => (item.enabled ? "enabled" : "disabled"),
    set: (enabled: boolean): void => {
      item.enabled = enabled;
    },
  };
  return item;
}

/** A value for a desktop entry's Exec key, quoted per the XDG spec. */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

export function linuxAutostartEntry(options: { exec: string; name: string }): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${options.name.replace(/[\r\n]/g, " ")}`,
    `Exec=${quoteExecArg(options.exec)} ${HIDDEN_LAUNCH_ARG}`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}

export function linuxAutostartPath(env: Record<string, string | undefined>, home: string): string {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(configHome, "autostart", LINUX_AUTOSTART_FILE);
}

export function createLinuxLoginItem(options: { exec: string; name: string; file?: string }): LoginItemBackend {
  const file = options.file ?? linuxAutostartPath(process.env, os.homedir());
  return {
    status: () => {
      try {
        return readFileSync(file, "utf8").includes(`Exec=${quoteExecArg(options.exec)}`) ? "enabled" : "disabled";
      } catch {
        return "disabled";
      }
    },
    set: (enabled) => {
      if (!enabled) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, linuxAutostartEntry(options), "utf8");
    },
  };
}

/** Whether this launch came from the login item. */
export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG);
}
