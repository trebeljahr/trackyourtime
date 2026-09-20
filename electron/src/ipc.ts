/*
 * Every `ipcMain.handle` goes through `handle()` here, which refuses a call
 * from any frame that is not the app's own document (trust.ts). The preload is
 * attached per window, not per URL, so a window that ever showed something
 * else — a mistaken navigation, a `data:` page — would otherwise still hold a
 * working bridge.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopIpcChannel } from "../../packages/shared/src/desktop-bridge.ts";
import { isTrustedSenderUrl } from "./trust.ts";

export class UntrustedSenderError extends Error {
  constructor(channel: string, url: string | null) {
    super(`Refused ${channel} from ${url ?? "a detached frame"}`);
    this.name = "UntrustedSenderError";
  }
}

let devUrl: string | null = null;

export function configureIpcTrust(options: { devUrl: string | null }): void {
  devUrl = options.devUrl;
}

export function senderUrl(event: IpcMainInvokeEvent): string | null {
  // `senderFrame` is null once the frame has navigated away or been destroyed.
  return event.senderFrame?.url ?? null;
}

export function handle<Args extends unknown[], Result>(
  channel: DesktopIpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const url = senderUrl(event);
    if (!isTrustedSenderUrl(url, devUrl)) {
      console.warn(`[ipc] ${channel} refused: sender ${url ?? "(no frame)"}`);
      throw new UntrustedSenderError(channel, url);
    }
    return handler(event, ...(args as Args));
  });
}
