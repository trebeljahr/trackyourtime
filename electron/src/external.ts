/*
 * Handing a URL to the OS: the browser for http(s), the mail client for
 * mailto:. Every caller goes through `openInOs`, the navigation guard
 * (security.ts) and the bridge's `openExternal` alike.
 *
 * In headless mode (tests, agents) nothing is handed over. Opening the
 * machine's browser — the "Sign in with your browser" approval page, a link on
 * the support page — would take focus from whoever is using the machine,
 * which is exactly what headless exists to prevent. The URL is recorded
 * instead, on `globalThis.__trackYourTimeOpenedExternally` for a Playwright
 * `app.evaluate`, and on stdout for a packaged build no inspector can reach.
 */

import { shell } from "electron";

import { isHeadless } from "./headless.ts";

export const OPENED_EXTERNALLY_GLOBAL = "__trackYourTimeOpenedExternally";

export async function openInOs(url: string): Promise<void> {
  if (isHeadless()) {
    const g = globalThis as Record<string, unknown>;
    const opened = Array.isArray(g[OPENED_EXTERNALLY_GLOBAL]) ? (g[OPENED_EXTERNALLY_GLOBAL] as string[]) : [];
    opened.push(url);
    g[OPENED_EXTERNALLY_GLOBAL] = opened;
    console.log(`[headless] not opening ${url}`);
    return;
  }
  await shell.openExternal(url);
}
