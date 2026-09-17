/*
 * The Electron security baseline, applied to every webContents the app ever
 * creates rather than to the one window we know about.
 *
 * - Navigation stays on the app's own origin. An http(s) or mailto: link that
 *   would leave it goes to the OS (browser, mail client); anything else is
 *   dropped.
 * - `window.open` never creates an Electron window. http(s) and mailto: go to
 *   the OS, and nothing else goes anywhere.
 * - `<webview>` is refused outright.
 * - Every permission request (camera, geolocation, clipboard-read, …) is
 *   denied, except notifications and clipboard writes from the app's own
 *   documents (`isPermissionGranted` in trust.ts).
 *
 * The IPC sender check is in ipc.ts, the CSP in csp.ts, the menu without
 * DevTools in menu.ts, and the fuses in electron-builder.config.mjs.
 */

import { app, session, type WebContents } from "electron";

import { openInOs } from "./external.ts";

import { isOsHandledUrl, isPermissionGranted, isTrustedSenderUrl } from "./trust.ts";

function openExternally(url: string): void {
  if (!isOsHandledUrl(url)) return;
  openInOs(url).catch((err: unknown) => {
    console.warn("[security] openExternal failed:", err);
  });
}

export function installSecurity(options: { devUrl: string | null }): void {
  const { devUrl } = options;
  const trusted = (url: string | null | undefined): boolean => isTrustedSenderUrl(url, devUrl);

  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      if (trusted(url)) return;
      event.preventDefault();
      openExternally(url);
    });

    contents.on("will-redirect", (event, url) => {
      if (trusted(url)) return;
      event.preventDefault();
    });

    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const url = details.requestingUrl || contents?.getURL();
      callback(isPermissionGranted(permission, url, devUrl));
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return isPermissionGranted(permission, requestingOrigin, devUrl);
    });
  });
}
