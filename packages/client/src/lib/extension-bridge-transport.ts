/**
 * Browser transports for the web app ↔ extension bridge.
 *
 * A page reaches an extension through `chrome.runtime.sendMessage(id, …)`,
 * which Chrome exposes only on origins some installed extension lists under
 * `externally_connectable`. Everything about that is optional from the page's
 * side: no Chrome, no extension, a different extension, an older one that
 * does not listen. Each of those must cost nothing and log nothing, so every
 * failure here resolves `undefined` — the same value Chrome gives when no
 * listener replied — and the caller decodes that as "no extension".
 *
 * Firefox uses a hosted-only window message relay when no page runtime exists.
 * The content script and background independently screen those requests.
 *
 * No `@types/chrome`: the page uses one function, and a narrow local type is
 * what keeps the rest of the extension API from looking available on the web.
 */
import { decodeExtensionBridgeRequest, decodeExtensionBridgeReply, isAllowedExtensionBridgeOrigin } from "@starter/shared/extension-bridge";
import { decodeExtensionRelayEnvelope, EXTENSION_RELAY_CHANNEL, FIREFOX_EXTENSION_ID } from "@starter/shared/extension-relay";
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
  extensionId === FIREFOX_EXTENSION_ID ? sendThroughPageRelay(message, timeoutMs) :
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

/** Firefox exposes no runtime to web pages. Only the hosted origin has a relay. */
export const pageRelayAvailable = (): boolean =>
  typeof window !== "undefined" && window.top === window &&
  isAllowedExtensionBridgeOrigin(window.location.origin, "production");

/** The same-origin page is trusted, but every envelope and payload is still decoded.
 * Correlation ids prevent stale replies satisfying newer requests; they are not credentials.
 */
export function sendThroughPageRelay(
  message: unknown,
  timeoutMs = EXTENSION_BRIDGE_TIMEOUT_MS,
  win: Window | undefined = typeof window === "undefined" ? undefined : window,
): Promise<unknown> {
  const request = decodeExtensionBridgeRequest(message);
  if (!request.ok || win === undefined || win.top !== win ||
      !isAllowedExtensionBridgeOrigin(win.location.origin, "production")) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const id = win.crypto.randomUUID();
    const finish = (value: unknown): void => {
      clearTimeout(timer);
      win.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== win || event.origin !== win.location.origin) return;
      const envelope = decodeExtensionRelayEnvelope(event.data);
      if (envelope?.direction !== "reply" || envelope.id !== id) return;
      const decoded = decodeExtensionBridgeReply(envelope.payload);
      if (decoded.ok) finish(decoded.message);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    win.addEventListener("message", onMessage);
    try {
      win.postMessage({ channel: EXTENSION_RELAY_CHANNEL, direction: "request", id, payload: request.message }, win.location.origin);
    } catch { finish(undefined); }
  });
}
