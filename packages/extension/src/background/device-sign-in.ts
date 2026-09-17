/**
 * Signing the extension in through the RFC 8628 device flow.
 *
 * Two ways in share everything here:
 *  - the web app linking the extension (`bridge.ts`, purpose `web-link`): a
 *    person signed in to the web app, the page approves a code the extension
 *    started, and the extension fetches a session of its own;
 *  - the popup's "Sign in with the web app" (purpose `manual`): the approval
 *    page opens in a tab, for any server, and for an account with two-factor
 *    authentication, which the password path cannot complete.
 *
 * The worker never long-polls. MV3 stops it after about thirty idle seconds,
 * and a `setTimeout` does not survive that, so the pending authorization lives
 * in `chrome.storage.session` (`lib/device-auth-store.ts`) and each event that
 * wakes the worker — the page's `device-approved`, the alarm, the popup
 * opening — makes one exchange against it. A manual sign-in also runs a loop
 * while the worker happens to be awake; the alarm is what finishes it when
 * it is not.
 *
 * Every exchange runs through {@link serially}, with the bridge's own
 * handling, so two tabs and an alarm can never spend one device code twice or
 * start two authorizations at once.
 */
import {
  AuthError,
  isLoopbackHost,
  requestDeviceToken,
  startDeviceAuthorization,
  signOutSession,
  CLIENT_HEADER,
  type DeviceAuthorization,
} from "@starter/core";
import { APP_VERSION } from "../lib/app-version";
import { EXTENSION_CLIENT_ID } from "../lib/config";
import {
  clearDeviceAuthFailure,
  clearDeviceSignInError,
  clearPendingDeviceAuth,
  createDeviceRequestId,
  DEVICE_AUTH_ALARM,
  isLivePendingDeviceAuth,
  loadPendingDeviceAuth,
  noteDeviceAuthFailure,
  saveDeviceSignInError,
  savePendingDeviceAuth,
  type DeviceAuthPurpose,
  type DeviceSignInError,
  type PendingDeviceAuth,
} from "../lib/device-auth-store";
import { clearLinkBlock, clearSignOutMarker } from "../lib/sign-out-marker";
import { BackgroundError } from "./errors";
import {
  adoptSession,
  ensureReady,
  flushQueue,
  refreshBadgeFromCache,
} from "./runtime";

/** What one exchange came to. The names are the bridge's device statuses. */
export type DeviceExchangeOutcome = "signed-in" | "pending" | "failed" | "expired";

/** How often Chrome may wake the worker for a popup-started sign-in: its floor. */
const DEVICE_ALARM_PERIOD_MINUTES = 0.5;

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after every task already queued, whatever became of them.
 * Never call it from inside a task: that task would wait for itself.
 */
export const serially = <T>(task: () => Promise<T>): Promise<T> => {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
};

const authOptions = (baseUrl: string): {
  baseUrl: string;
  clientId: typeof EXTENSION_CLIENT_ID;
  clientVersion: string;
} => ({ baseUrl, clientId: EXTENSION_CLIENT_ID, clientVersion: APP_VERSION });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clearDeviceAlarm = async (): Promise<void> => {
  try {
    await chrome.alarms.clear(DEVICE_AUTH_ALARM);
  } catch {
    /* no alarm to clear */
  }
};

/**
 * Who a freshly issued token belongs to.
 *
 * better-auth's `/device/token` answers with the token alone, so the account
 * is asked for with it. Null when the server would not say — which, for a
 * link the web app started, is reason enough not to keep the token.
 */
export async function lookUpSessionUser(
  apiUrl: string,
  token: string,
): Promise<{ userId: string; email: string | null } | null> {
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/auth/get-session`, {
      headers: {
        authorization: `Bearer ${token}`,
        [CLIENT_HEADER]: EXTENSION_CLIENT_ID,
      },
      credentials: "omit",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const user =
      typeof body === "object" && body !== null
        ? (body as { user?: { id?: unknown; email?: unknown } }).user
        : undefined;
    if (typeof user?.id !== "string" || user.id === "") return null;
    return {
      userId: user.id,
      email: typeof user.email === "string" && user.email !== "" ? user.email : null,
    };
  } catch {
    return null;
  }
}

/** The approval page may only be an https page, or http on this machine. */
export const isAllowedVerificationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
};

/**
 * End `record`'s authorization without a session: forget it, and say why
 * where somebody will look. Only if it is still the stored one — a newer
 * authorization started meanwhile is not this one's to end.
 */
const endWithout = async (
  record: PendingDeviceAuth,
  outcome: "failed" | "expired",
  reason: DeviceSignInError,
): Promise<DeviceExchangeOutcome> => {
  const stored = await loadPendingDeviceAuth();
  if (stored !== null && stored.requestId !== record.requestId) return outcome;
  await clearPendingDeviceAuth();
  await clearDeviceAlarm();
  if (record.purpose === "web-link") {
    // The bridge waits before starting another, so a page that cannot approve
    // is not answered with a fresh `/device/code` on every focus.
    await noteDeviceAuthFailure(Date.now());
  } else {
    await saveDeviceSignInError(reason);
  }
  return outcome;
};

const sourceFor = (purpose: DeviceAuthPurpose): "web" | "device" =>
  purpose === "web-link" ? "web" : "device";

/**
 * One `/device/token` exchange for `record`, and everything that follows an
 * answer. Call only from inside {@link serially}.
 */
const exchangeOnce = async (record: PendingDeviceAuth): Promise<DeviceExchangeOutcome> => {
  const current = await ensureReady();
  if (!isLivePendingDeviceAuth(record, current.apiUrl, Date.now())) {
    return endWithout(record, "expired", "expired");
  }

  let issued: { token: string };
  try {
    const result = await requestDeviceToken(authOptions(current.apiUrl), record.deviceCode);
    if (result.status !== "approved") return "pending";
    issued = result.session;
  } catch (error) {
    if (!(error instanceof AuthError)) return "pending"; // no answer: try again later
    if (error.code === "expired_token") return endWithout(record, "expired", "expired");
    if (/^HTTP_5\d\d$/.test(error.code)) return "pending";
    return endWithout(record, "failed", error.code === "access_denied" ? "denied" : "failed");
  }

  const user = await lookUpSessionUser(current.apiUrl, issued.token);
  if (record.purpose === "web-link" && user?.userId !== record.forUserId) {
    // Approved by somebody other than the person the page said was signed in
    // — or nobody would say who. Never kept.
    try {
      await signOutSession(authOptions(current.apiUrl), issued.token);
    } catch {
      /* best effort */
    }
    return endWithout(record, "failed", "failed");
  }

  await clearPendingDeviceAuth();
  await clearDeviceAlarm();
  await clearDeviceAuthFailure();
  await clearDeviceSignInError();
  // Signed in again: an old extension sign-out has nothing more to ask of the
  // web app, and nothing stands in the way of linking again later.
  await clearSignOutMarker();
  await clearLinkBlock();
  await adoptSession({
    token: issued.token,
    userId: user?.userId ?? null,
    email: user?.email ?? null,
    source: sourceFor(record.purpose),
  });
  // `flushQueue` claims rows from before the owner stamp for this account and
  // sends what is this account's.
  await flushQueue().catch(() => undefined);
  await refreshBadgeFromCache().catch(() => undefined);
  return "signed-in";
};

/**
 * Exchange `record` up to `attempts` times, `delayMs` apart while the server
 * still says pending. Call only from inside {@link serially}.
 */
export const exchangePendingDeviceAuth = async (
  record: PendingDeviceAuth,
  attempts = 1,
  delayMs = 1000,
): Promise<DeviceExchangeOutcome> => {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await exchangeOnce(record);
    if (outcome !== "pending" || attempt >= attempts) return outcome;
    await sleep(delayMs);
  }
};

/**
 * One exchange for whatever authorization is stored, if any. What the alarm,
 * the popup's snapshot and any other wake-up call. Null when nothing is
 * pending.
 */
export function attemptPendingDeviceSignIn(): Promise<DeviceExchangeOutcome | null> {
  return serially(async () => {
    const record = await loadPendingDeviceAuth();
    if (record === null) {
      await clearDeviceAlarm();
      return null;
    }
    return exchangePendingDeviceAuth(record);
  });
}

/**
 * Start a device authorization against the server in use and store it.
 * Call only from inside {@link serially}. Throws what the server refused with.
 */
export const beginDeviceAuthorization = async (
  apiUrl: string,
  purpose: DeviceAuthPurpose,
  forUserId: string | null,
): Promise<{ record: PendingDeviceAuth; authorization: DeviceAuthorization }> => {
  const authorization = await startDeviceAuthorization(authOptions(apiUrl));
  const record: PendingDeviceAuth = {
    requestId: createDeviceRequestId(),
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    apiOrigin: apiUrl,
    purpose,
    forUserId: purpose === "web-link" ? forUserId : null,
    expiresAt: Date.now() + authorization.expiresInSeconds * 1000,
    intervalSeconds: Math.max(1, authorization.intervalSeconds),
  };
  return { record, authorization };
};

/**
 * Keep exchanging a popup-started authorization while this worker lives.
 *
 * Each round re-reads the stored record: that is a Chrome API call, which
 * keeps the worker awake between polls, and it is how a cancel (or a finish
 * from the alarm) stops the loop.
 */
const pollWhileAwake = async (requestId: string): Promise<void> => {
  for (;;) {
    const record = await loadPendingDeviceAuth();
    if (record === null || record.requestId !== requestId) return;
    await sleep(record.intervalSeconds * 1000);
    const outcome = await serially(async () => {
      const again = await loadPendingDeviceAuth();
      if (again === null || again.requestId !== requestId) return null;
      return exchangePendingDeviceAuth(again);
    });
    if (outcome !== "pending") return;
  }
};

/**
 * "Sign in with the web app", from the popup.
 *
 * Starts an authorization, opens its approval page in a tab (no permission
 * needed), and keeps an alarm so the exchange finishes even after the popup
 * closes and the worker is stopped.
 */
export async function startDeviceSignIn(): Promise<void> {
  const current = await ensureReady();
  if (current.session !== null) return;

  const { record, authorization } = await serially(async () => {
    const started = await beginDeviceAuthorization(current.apiUrl, "manual", null);
    if (!isAllowedVerificationUrl(started.authorization.verificationUriComplete)) {
      throw new BackgroundError(
        "DEVICE_URL_INVALID",
        "The server sent an approval page address the extension will not open.",
      );
    }
    await savePendingDeviceAuth(started.record);
    await clearDeviceSignInError();
    return started;
  });

  await chrome.alarms.create(DEVICE_AUTH_ALARM, {
    periodInMinutes: DEVICE_ALARM_PERIOD_MINUTES,
  });
  await chrome.tabs.create({ url: authorization.verificationUriComplete });
  void pollWhileAwake(record.requestId).catch(() => undefined);
}

/** Stop waiting for the popup's device sign-in. */
export async function cancelDeviceSignIn(): Promise<void> {
  await serially(async () => {
    const record = await loadPendingDeviceAuth();
    if (record?.purpose === "manual") await clearPendingDeviceAuth();
    await clearDeviceSignInError();
  });
  await clearDeviceAlarm();
}
