/*
 * The tray icon (the menu bar item on macOS), drawn from `tray-model.ts`.
 *
 * macOS: a template icon, which the system tints for light and dark menu
 * bars, and the running clock as its title. Windows and Linux: `setTitle`
 * does not exist there, so the clock goes in the tooltip and a second icon
 * marks a running timer. Windows opens the window on a left click and the
 * menu on a right click; macOS and Linux (AppIndicator only knows menus) open
 * the menu on any click.
 *
 * Never created in headless runs (desktop.ts): a tray icon is on the screen
 * of whoever is using the machine.
 */

import path from "node:path";
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from "electron";

import type { DesktopTimerState } from "../../packages/shared/src/desktop-bridge.ts";
import {
  trayIconFile,
  trayIconVariant,
  trayMenuModel,
  trayTitle,
  trayTooltip,
  type TrayIconVariant,
  type TrayMenuItem,
} from "./tray-model.ts";

export interface TrayView {
  /** Redraw from state; cheap to call every second (the menu is rebuilt only when it changed). */
  update: (state: DesktopTimerState | null, nowMs: number, updateReady: boolean) => void;
  destroy: () => void;
}

export function menuTemplate(model: TrayMenuItem[], onItem: (id: string) => void): MenuItemConstructorOptions[] {
  return model.map((item): MenuItemConstructorOptions => {
    if (item.type === "separator") return { type: "separator" };
    if (item.type === "heading") return { label: item.label, enabled: false };
    return { label: item.label, enabled: item.enabled, click: () => onItem(item.id) };
  });
}

export function createElectronTray(options: {
  iconDir: string;
  platform: NodeJS.Platform;
  onItem: (id: string) => void;
  onActivate: () => void;
}): TrayView {
  const icons = new Map<TrayIconVariant, NativeImage>();
  const icon = (variant: TrayIconVariant): NativeImage => {
    let image = icons.get(variant);
    if (!image) {
      image = nativeImage.createFromPath(path.join(options.iconDir, trayIconFile(options.platform, variant)));
      if (options.platform === "darwin") image.setTemplateImage(true);
      icons.set(variant, image);
    }
    return image;
  };

  let variant: TrayIconVariant = "idle";
  const tray = new Tray(icon(variant));
  if (options.platform === "win32") tray.on("click", options.onActivate);

  let lastMenu = "";
  let lastTitle: string | null = null;
  let lastTooltip = "";

  return {
    update: (state, nowMs, updateReady) => {
      if (tray.isDestroyed()) return;
      const model = trayMenuModel(state, { updateReady });
      const menuKey = JSON.stringify(model);
      if (menuKey !== lastMenu) {
        lastMenu = menuKey;
        tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(model, options.onItem)));
      }
      const nextVariant = trayIconVariant(state);
      if (nextVariant !== variant) {
        variant = nextVariant;
        tray.setImage(icon(variant));
      }
      if (options.platform === "darwin") {
        const title = trayTitle(state, nowMs, options.platform);
        if (title !== lastTitle) {
          lastTitle = title;
          // Monospaced digits, so the item does not jitter as the clock ticks.
          tray.setTitle(title, { fontType: "monospacedDigit" });
        }
      }
      const tooltip = trayTooltip(state, nowMs);
      if (tooltip !== lastTooltip) {
        lastTooltip = tooltip;
        tray.setToolTip(tooltip);
      }
    },
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
