/**
 * The one door from the web page to the browser extension.
 *
 * A page reaches an extension through `chrome.runtime.sendMessage(id, …)`,
 * which Chrome exposes only on origins some installed extension lists under
 * `externally_connectable`. Everything about that is optional from the page's
 * side: no Chrome, no extension, a different extension, an older one that
 * does not listen. Each of those must cost nothing and log nothing, so every
 * failure here resolves `undefined` — the same value Chrome gives when no
 * listener replied — and the caller decodes that as "no extension".
 *
 * No `@types/chrome`: the page uses one function, and a narrow local type is
 * what keeps the rest of the extension API from looking available on the web.
 */
import { STORE_EXTENSION_ID } from "@starter/shared";

/** How long the page waits for an extension to answer. */
export const EXTENSION_BRIDGE_TIMEOUT_MS = 5_000;

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

type ChromeRuntimeLike = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => unknown;
  lastError?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null;

/**
 * `globalThis.chrome.runtime`, when it can message an extension. `null` on
 * every other browser, and in Chrome on an origin no extension connects to.
 */
export const chromeRuntime = (
  scope: unknown = globalThis,
): ChromeRuntimeLike | null => {
  try {
    if (!isRecord(scope)) return null;
    const chrome = scope.chrome;
    if (!isRecord(chrome)) return null;
    const runtime = chrome.runtime;
    if (!isRecord(runtime) || typeof runtime.sendMessage !== "function") return null;
    return runtime as ChromeRuntimeLike;
  } catch {
    return null;
  }
};

/**
 * Send one message to one extension and resolve its reply, or `undefined`
 * when there is none to be had: not installed, not listening, an invocation
 * Chrome refuses, a `runtime.lastError`, or no answer within `timeoutMs`.
 * Never rejects.
 */
export const sendToExtension = (
  extensionId: string,
  message: unknown,
  timeoutMs: number = EXTENSION_BRIDGE_TIMEOUT_MS,
  runtime: ChromeRuntimeLike | null = chromeRuntime(),
): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    if (runtime === null || !EXTENSION_ID_PATTERN.test(extensionId)) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      runtime.sendMessage(extensionId, message, (response: unknown) => {
        // Reading `lastError` inside the callback is what tells Chrome the
        // error was handled; left unread it lands in the console as
        // "Unchecked runtime.lastError" on every page load without the
        // extension.
        const failed = runtime.lastError !== undefined && runtime.lastError !== null;
        finish(failed ? undefined : response);
      });
    } catch {
      // Chrome throws synchronously for an id no extension on this origin
      // answers to.
      finish(undefined);
    }
  });

/**
 * The extension ids this build messages. `NEXT_PUBLIC_EXTENSION_IDS`
 * (comma-separated) when set — `scripts/dev.mjs` sets the checkout's unpacked
 * id and the store id — otherwise the store id. Anything that is not a Chrome
 * extension id is dropped, and duplicates are sent to once.
 */
export const extensionIds = (
  configured: string | undefined = process.env.NEXT_PUBLIC_EXTENSION_IDS,
): string[] => {
  const raw =
    configured === undefined || configured.trim() === ""
      ? [STORE_EXTENSION_ID]
      : configured.split(",").map((id) => id.trim());
  return [...new Set(raw.filter((id) => EXTENSION_ID_PATTERN.test(id)))];
};
