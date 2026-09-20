/*
 * The application menu.
 *
 * A production build has no Reload, Force Reload or Toggle DevTools, and no
 * accelerator for them: a reload throws away an unsaved form, and DevTools in
 * a shipped app is a way to read the session token out of the renderer. The
 * window is also created with `devTools: false` outside dev (window.ts), so
 * the menu is not the only thing standing between a user and the inspector.
 *
 * macOS keeps an Edit menu because Cmd+C/V/X/A/Z reach text fields only
 * through menu roles there. Windows and Linux need no menu for those, so they
 * get none (and with it, no Alt-key menu bar).
 */

import { app, Menu, type MenuItemConstructorOptions } from "electron";

export function buildMenuTemplate(options: {
  platform: NodeJS.Platform;
  dev: boolean;
  appName: string;
}): MenuItemConstructorOptions[] | null {
  const devItems: MenuItemConstructorOptions[] = options.dev
    ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }]
    : [];

  if (options.platform !== "darwin") {
    return options.dev ? [{ label: "View", submenu: devItems }] : null;
  }

  return [
    {
      label: options.appName,
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
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [...devItems, { role: "togglefullscreen" }],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];
}

export function installApplicationMenu(dev: boolean): void {
  const template = buildMenuTemplate({ platform: process.platform, dev, appName: app.name });
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}
