import { readBrowserAccount, approveBrowserDevice, clearBrowserAccountOfferCache } from "./browser-account";
/**
 * Trusted web pages offer an account; only a popup confirmation starts a
 * device authorization. Each app keeps its own session after that sign-in.
 * Sender, server and account checks apply to every bridge exchange.
 */
import { decodeExtensionRelayEnvelope } from "@starter/shared/extension-relay";
import {
  decodeExtensionBridgeRequest,
  extensionBridgeDeviceReply,
  extensionBridgeSyncReply,
  extensionBridgeUnsupportedReply,
  isAllowedExtensionBridgeOrigin,
  type ExtensionBridgeDeviceApprovedRequest,
  type ExtensionBridgeIgnoreReason,
  type ExtensionBridgeReply,
  type ExtensionBridgeRequest,
  type ExtensionBridgeSyncRequest,
  type ExtensionBridgeTarget,
} from "@starter/shared/extension-bridge";
import { loadWebAccount, saveWebAccount } from "../lib/web-account";
import { BackgroundError } from "./errors";
import { sameServerOrigin } from "@starter/core";
import { BRIDGE_TARGET, loadServerInfo } from "../lib/config";
import {
  clearPendingDeviceAuth,
  clearDeviceSignInError,
  saveDeviceSignInError,
  DEVICE_AUTH_ALARM,
  isLivePendingDeviceAuth,
  loadPendingDeviceAuth,
  savePendingDeviceAuth,
  type PendingDeviceAuth,
} from "../lib/device-auth-store";
import {
  clearSignOutMarker,
  clearLinkBlock,
} from "../lib/sign-out-marker";
import {
  beginDeviceAuthorization,
  exchangePendingDeviceAuth,
  serially,
} from "./device-sign-in";
import {
  ensureReady,
  getCachedServerInfo,
  resolveWebUrl,
} from "./runtime";

/** The parts of `chrome.runtime.MessageSender` the checks read. */
export type BridgeSender = {
  origin?: string;
  url?: string;
  id?: string;
  /** 0 for a tab's top-level document. */
  frameId?: number;
  tab?: { id?: number; incognito?: boolean } | null;
};

export type BridgeOptions = {
  /** Gap between the up-to-three exchanges after `device-approved`. */
  retryDelayMs?: number;
  /** Injectable clock for account freshness and authorization expiry. */
  now?: () => number;
};

/**
 * The synchronous half: who sent it, and is it a bridge message at all.
 *
 * `reply: undefined` means "say nothing" — a stranger learns nothing, not even
 * that an extension is listening.
 */
export const screenExternalMessage = (
  message: unknown,
  sender: BridgeSender,
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
):
  | { ok: true; request: ExtensionBridgeRequest; origin: string }
  | { ok: false; reply: ExtensionBridgeReply | undefined } => {
  if (!isAllowedExtensionBridgeOrigin(sender.origin, target)) {
    return { ok: false, reply: undefined };
  }
  // A page, not another extension, and a page in a tab.
  if (sender.id !== undefined || sender.tab === undefined || sender.tab === null) {
    return { ok: false, reply: undefined };
  }
  // The tab's top-level document only. Any site can frame the web app, and a
  // cross-site frame must not publish account offers. An incognito tab's
  // session is not this browser's either.
  if (sender.frameId !== 0 || sender.tab.incognito === true) {
    return { ok: false, reply: undefined };
  }
  const decoded = decodeExtensionBridgeRequest(message);
  if (!decoded.ok) {
    return {
      ok: false,
      reply: decoded.problem === "unsupported-version" ? extensionBridgeUnsupportedReply() : undefined,
    };
  }
  return { ok: true, request: decoded.message, origin: sender.origin as string };
};

/**
 * Whether `sender` is the web app of `webUrl`. A development build also takes
 * `localhost` and `127.0.0.1` as one host, on the same port: the dev server
 * may name either, and a person may type either.
 */
export const isWebAppOrigin = (
  sender: string,
  webUrl: string,
  target: ExtensionBridgeTarget,
): boolean => {
  let a: URL;
  let b: URL;
  try {
    a = new URL(sender);
    b = new URL(webUrl);
  } catch {
    return false;
  }
  if (a.origin === b.origin) return true;
  if (target !== "development") return false;
  const loopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1";
  return (
    a.protocol === b.protocol &&
    a.port === b.port &&
    loopback(a.hostname) &&
    loopback(b.hostname)
  );
};

/** The web app URL of `apiUrl`, from what is known, else from its `/api/health`. */
const webUrlOf = async (apiUrl: string): Promise<string | null> => {
  const live = getCachedServerInfo();
  if (live !== null && sameServerOrigin(live.origin, apiUrl) && live.webUrl !== null) {
    return live.webUrl;
  }
  const stored = await loadServerInfo().catch(() => null);
  if (stored !== null && sameServerOrigin(stored.origin, apiUrl) && stored.webUrl !== null) {
    return stored.webUrl;
  }
  return resolveWebUrl();
};

const none = (reason: ExtensionBridgeIgnoreReason): ExtensionBridgeReply =>
  extensionBridgeSyncReply({ type: "none", reason });

const approve = (record: PendingDeviceAuth): ExtensionBridgeReply =>
  extensionBridgeSyncReply({
    type: "approve-device",
    requestId: record.requestId,
    userCode: record.userCode,
    expiresAt: record.expiresAt,
  });

/** The only entry point that can start a web-account sign-in: an internal popup action. */
export const confirmWebAccount = (userId: string, sessionCreatedAt: number): Promise<void> =>
  serially(async () => {
    const current = await ensureReady();
    if (current.session !== null) return;
    const browser = await readBrowserAccount(current.apiUrl);
    const account = browser === undefined ? await loadWebAccount(current.apiUrl) : browser?.account ?? null;
    if (account === null || account.userId !== userId || account.sessionCreatedAt !== sessionCreatedAt) {
      throw new BackgroundError("WEB_ACCOUNT_CHANGED", "The web account changed. Refresh the account offer and try again.");
    }
    const pending = await loadPendingDeviceAuth();
    if (pending !== null && isLivePendingDeviceAuth(pending, current.apiUrl, Date.now())) return;
    const { record } = await beginDeviceAuthorization(current.apiUrl, "web-confirmed", userId);
    await savePendingDeviceAuth(record);
    await clearDeviceSignInError();
    await chrome.alarms.create(DEVICE_AUTH_ALARM, { periodInMinutes: 0.5 });
    if (browser) {
      try {
        await approveBrowserDevice(current.apiUrl, browser.token, record.userCode);
        // The popup message handler builds and saves the fresh state after this
        // action. Avoid loading every catalog and today total twice.
        await exchangePendingDeviceAuth(record, 1, 1000, false);
      } catch {
        await clearPendingDeviceAuth();
        await chrome.alarms.clear(DEVICE_AUTH_ALARM);
        throw new BackgroundError("WEB_ACCOUNT_CHANGED", "Could not sign in with the web account. Try again.");
      }
    }
  });

const handleSync = async (
  request: ExtensionBridgeSyncRequest,
  now: number,
): Promise<ExtensionBridgeReply> => {
  const { web } = request;
  const current = await ensureReady();
  if (!sameServerOrigin(request.apiOrigin, current.apiUrl)) return none("other-server");
  // Discard legacy cross-app logout instructions; they no longer have authority.
  await clearSignOutMarker();
  await clearLinkBlock();
  clearBrowserAccountOfferCache();
  await saveWebAccount(current.apiUrl, web.userId !== null && web.sessionCreatedAt !== null && web.profile ? {
    userId: web.userId,
    sessionCreatedAt: web.sessionCreatedAt,
    ...web.profile,
  } : null, now);

  // Neither a web logout nor a switch to another web account changes this session.
  if (current.session !== null) return none("explicit-session");

  const pending = await loadPendingDeviceAuth();
  if (pending !== null && pending.purpose === "web-confirmed") {
    if (!isLivePendingDeviceAuth(pending, current.apiUrl, now) || pending.forUserId !== web.userId) {
      await clearPendingDeviceAuth();
    } else {
      return approve(pending);
    }
  }
  return none(web.userId === null ? "signed-out" : "confirmation-required");
};

const handleDeviceApproved = async (
  request: ExtensionBridgeDeviceApprovedRequest,
  retryDelayMs: number,
): Promise<ExtensionBridgeReply> => {
  const current = await ensureReady();
  const record = await loadPendingDeviceAuth();
  if (
    record === null ||
    record.purpose !== "web-confirmed" ||
    record.requestId !== request.requestId ||
    !sameServerOrigin(record.apiOrigin, current.apiUrl)
  ) {
    return extensionBridgeDeviceReply("failed");
  }
  if (request.outcome === "failed") {
    await clearPendingDeviceAuth();
    await saveDeviceSignInError("failed");
    return extensionBridgeDeviceReply("failed");
  }
  const outcome = await exchangePendingDeviceAuth(record, 3, retryDelayMs);
  return extensionBridgeDeviceReply(outcome);
};

/**
 * Everything after the sender and the shape checked out: the server, the web
 * app's origin, and then the decision — serialised with every other device
 * exchange, so two tabs cannot start two authorizations.
 */
export async function handleBridgeRequest(
  request: ExtensionBridgeRequest,
  origin: string,
  options: BridgeOptions = {},
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
): Promise<ExtensionBridgeReply> {
  const now = options.now ?? Date.now;
  const refuse = (reason: ExtensionBridgeIgnoreReason): ExtensionBridgeReply =>
    request.kind === "sync" ? none(reason) : extensionBridgeDeviceReply("failed");

  const current = await ensureReady();
  // A message never moves the extension to another server.
  if (!sameServerOrigin(request.apiOrigin, current.apiUrl)) return refuse("other-server");

  const webUrl = await webUrlOf(current.apiUrl);
  if (webUrl === null) return refuse("server-unavailable");
  if (!isWebAppOrigin(origin, webUrl, target)) return refuse("origin-mismatch");

  return serially(() =>
    request.kind === "sync"
      ? handleSync(request, now())
      : handleDeviceApproved(request, options.retryDelayMs ?? 1000),
  );
}

/** A content-script sender must be our own add-on in the allowed top-level document.
 * Firefox supplies the document URL; never accept origin claims from the payload.
 */
export function screenRelayMessage(
  message: unknown,
  sender: BridgeSender,
  ownId: string,
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
): ReturnType<typeof screenExternalMessage> {
  const silent = { ok: false, reply: undefined } as const;
  const envelope = decodeExtensionRelayEnvelope(message);
  if (sender.id !== ownId || envelope?.direction !== "request" || !sender.url) return silent;
  let origin: string;
  try { origin = new URL(sender.url).origin; } catch { return silent; }
  if (sender.origin !== undefined && sender.origin !== origin) return silent;
  return screenExternalMessage(envelope.payload, { ...sender, id: undefined, origin }, target);
}

/** Register synchronously so messages wake the background event page or worker. */
export function registerBridgeListener(
  target: ExtensionBridgeTarget = BRIDGE_TARGET,
  transport: "relay" | "external" = import.meta.env.VITE_BRIDGE_TRANSPORT === "relay" ? "relay" : "external",
): void {
  if (target === "none") return;
  const event = transport === "relay" ? chrome.runtime.onMessage : chrome.runtime.onMessageExternal;
  event.addListener(
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: unknown) => void) => {
      const screened = transport === "relay"
        ? screenRelayMessage(message, sender, chrome.runtime.id, target)
        : screenExternalMessage(message, sender, target);
      if (!screened.ok) {
        if (screened.reply === undefined) return false;
        sendResponse(screened.reply);
        return false;
      }
      void handleBridgeRequest(screened.request, screened.origin, {}, target)
        .catch((): ExtensionBridgeReply =>
          screened.request.kind === "sync"
            ? none("server-unavailable")
            : extensionBridgeDeviceReply("failed"),
        )
        .then((reply) => {
          try { sendResponse(reply); } catch { /* Document closed. */ }
        });
      return true;
    },
  );
}
