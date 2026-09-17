/*
 * electron-updater, bound to the controller in `updater-model.ts`.
 *
 * Direct downloads only (macOS dmg/zip, the Windows NSIS installer, the
 * AppImage), from GitHub Releases through the `app-update.yml` electron-builder
 * writes beside the app when the build has a feed. Everything else — the two
 * stores, Snap, Flatpak, deb, rpm, tar.gz, unsigned and local builds — never
 * loads electron-updater at all.
 *
 * **Headless** (tests, agents): the real updater is never loaded and nothing
 * touches the network. A memory updater stands in, which does nothing until a
 * spec drives it through `__trackYourTimeDesktop.update` (desktop.ts), so the
 * "Restart to update" item and button can be exercised without a release, and
 * its `quitAndInstall` is recorded instead of quitting.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

import type { DesktopUpdateSnapshot } from "../../packages/shared/src/desktop-bridge.ts";
import { distributionChannel } from "./distribution.ts";
import {
  createUpdateController,
  updaterPolicy,
  type UpdateController,
  type UpdaterLike,
  type UpdaterPolicy,
} from "./updater-model.ts";

export interface MemoryUpdater extends UpdaterLike {
  installs: number;
  checks: number;
}

function createMemoryUpdater(): MemoryUpdater {
  const updater: MemoryUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    installs: 0,
    checks: 0,
    checkForUpdates: () => {
      updater.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall: () => {
      updater.installs += 1;
    },
    on: () => updater,
  };
  return updater;
}

export function resolveUpdaterPolicy(isPackaged: boolean): UpdaterPolicy {
  return updaterPolicy({
    channel: distributionChannel({
      platform: process.platform,
      isPackaged,
      mas: process.mas === true,
      windowsStore: process.windowsStore === true,
      env: process.env,
    }),
    hasFeed: isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml")),
    env: process.env,
  });
}

export function installUpdater(options: {
  headless: boolean;
  onChange: (snapshot: DesktopUpdateSnapshot) => void;
  beforeInstall: () => void;
}): { controller: UpdateController; memory: MemoryUpdater | null } {
  const memory = options.headless ? createMemoryUpdater() : null;
  const controller = createUpdateController({
    policy: memory ? { enabled: true } : resolveUpdaterPolicy(app.isPackaged),
    currentVersion: app.getVersion(),
    loadUpdater: () => {
      if (memory) return memory;
      // Loaded only here, so a store or package-manager build never runs
      // electron-updater's module code (which inspects the install on load).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
      autoUpdater.logger = {
        info: (message: unknown) => console.log("[updater]", message),
        warn: (message: unknown) => console.warn("[updater]", message),
        error: (message: unknown) => console.error("[updater]", message),
        debug: () => undefined,
      };
      return autoUpdater as unknown as UpdaterLike;
    },
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    },
    now: () => new Date(),
    onChange: options.onChange,
    beforeInstall: options.beforeInstall,
    log: (message, err) => console.warn(message, err),
  });
  return { controller, memory };
}
