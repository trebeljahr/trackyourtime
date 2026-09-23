/**
 * Turn a {@link BackgroundResponse} failure into something a user can act on,
 * in the popup's language.
 *
 * The worker forwards core's `AuthError.code` untouched, and those codes are
 * written for programs: "NO_SESSION_TOKEN" tells a developer the server is
 * missing the bearer plugin and tells a user nothing at all. Three cases in
 * particular have to land, because each has a different fix:
 *
 *   - bad credentials      → retype the password
 *   - unreachable server   → fix the server address, or start the server
 *   - no session token     → the server is wrong, not the password; retrying
 *                            forever is the failure mode to avoid here
 *
 * Translated HERE, from the code, rather than in the worker: the popup always
 * knows the reader's language synchronously, while a worker MV3 evicts every
 * thirty seconds wakes up without its settings. The worker's own `message`
 * is English developer text, used only for a code this file does not know —
 * so a new server-side code still says something true.
 */
import type { PopupT } from "../i18n/use-t";
import type { ErrorDetails } from "../lib/messaging";

import { serverHost, TWO_FACTOR_UNSUPPORTED, type ServerInputProblem } from "@starter/core";
import { isRandomExtensionOrigin } from "@starter/shared";
import type { DeviceSignInError } from "../lib/messaging";

/**
 * This extension's own origin, as a server admin would type it into
 * TRUSTED_ORIGINS. Read at call time, so a test without `chrome` still gets a
 * sentence.
 *
 * From `runtime.getURL("/")`, never from `runtime.id`: the id IS the origin's
 * host on Chromium, and on Firefox it is the add-on id
 * (`trackyourtime@ricoslabs.com`) while the origin is a random
 * `moz-extension://<uuid>`. Composing one from the other names an origin that
 * does not exist, in the one message whose whole job is to be copied.
 */
export const extensionOrigin = (): string => {
  const runtime = (globalThis as {
    chrome?: { runtime?: { getURL?: (path: string) => string; id?: unknown } };
  }).chrome?.runtime;
  const url = runtime?.getURL?.("/");
  if (typeof url === "string" && url !== "") return url.replace(/\/$/, "");
  const id = runtime?.id;
  return typeof id === "string" && id !== "" ? `chrome-extension://${id}` : "chrome-extension://…";
};

/**
 * Which sentence a refusing server gets.
 *
 * A Chromium extension has a pinned origin, so the fix is one line in
 * TRUSTED_ORIGINS. A Firefox or Safari one has a per-install random origin
 * that no list can hold — naming TRUSTED_ORIGINS there sends the admin to add
 * a value that would stop working on the next install — so it names
 * TRUST_EXTENSION_ORIGINS, the rule that trusts the shape instead.
 */
export const originNotTrustedKey = (): "originNotTrusted" | "originNotTrustedRandom" =>
  isRandomExtensionOrigin(extensionOrigin())
    ? "originNotTrustedRandom"
    : "originNotTrusted";

const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_CREDENTIALS",
  "INVALID_PASSWORD",
  "USER_NOT_FOUND",
  "HTTP_401",
  "HTTP_403",
]);

const NETWORK_CODES: ReadonlySet<string> = new Set([
  // "UNREACHABLE" is the one the worker actually emits (background/errors.ts);
  // the rest are defensive, for codes a future server or transport might use.
  "UNREACHABLE",
  "NETWORK_ERROR",
  "FETCH_FAILED",
  "NETWORK",
  "ECONNREFUSED",
]);

/** The worker being asleep or dead is not the server's fault — say so. */
const WORKER_CODES: ReadonlySet<string> = new Set(["NO_RESPONSE", "PORT_CLOSED"]);

/**
 * `fetch` rejects with a bare TypeError whose code the worker cannot improve
 * on, so the message text is the only signal that the server was unreachable.
 */
const looksLikeNetworkFailure = (message: string): boolean =>
  /failed to fetch|networkerror|load failed|econnrefused|fetch failed/i.test(
    message,
  );

/**
 * Codes with one fixed meaning, whichever of the worker, better-auth or tRPC
 * raised them. Codes that carry a specific server sentence (BAD_REQUEST,
 * CONFLICT) are deliberately absent: a generic line would say less than the
 * server did.
 */
const fixedMessage = (code: string, t: PopupT, server: string): string | null => {
  switch (code) {
    case "ACTIVITY_UNAVAILABLE":
      return t("errors.activityUnavailable");
    case "ACTIVITY_PERMISSION_REQUIRED":
      return t("errors.activityPermission");
    case "SUGGESTION_ALREADY_TRACKED":
      return t("errors.suggestionTracked");
    case "ORIGIN_NOT_TRUSTED":
      return t(`errors.${originNotTrustedKey()}`, { server, origin: extensionOrigin() });
    case "DEVICE_URL_INVALID":
      return t("errors.deviceUrlInvalid");
    case "SERVER_UNREACHABLE":
      return t("errors.serverUnreachable", { server });
    case "NOT_TRACKYOURTIME":
      return t("errors.notTrackYourTime", { server });
    case "SERVER_UNHEALTHY":
      return t("errors.serverUnhealthy", { server });
    case "UNSENT_CHANGES":
      return t("errors.unsentChanges");
    case "INVALID_EMAIL":
      return t("errors.invalidEmail");
    case "EMAIL_NOT_VERIFIED":
      return t("errors.emailNotVerified");
    case TWO_FACTOR_UNSUPPORTED:
      return t("errors.twoFactorUnsupported");
    case "NO_FETCH":
      return t("errors.noFetch");
    case "NOT_SIGNED_IN":
      return t("errors.notSignedIn");
    case "STILL_SYNCING":
      return t("errors.stillSyncing");
    case "BAD_TIME_RANGE":
      return t("errors.badTimeRange");
    case "REVOKE_SELF":
      return t("errors.revokeSelf");
    case "NOT_RUNNING":
      return t("errors.notRunning");
    case "INVALID_API_URL":
      return t("errors.invalidApiUrl");
    case "BAD_MESSAGE":
      return t("errors.badMessage");
    case "FORBIDDEN":
      return t("errors.forbidden");
    case "NOT_FOUND":
      return t("errors.notFound");
    case "TOO_MANY_REQUESTS":
      return t("errors.tooManyRequests");
    case "UNKNOWN":
    case "INTERNAL_SERVER_ERROR":
      return t("errors.generic");
    default:
      return null;
  }
};

/**
 * A server below this build's API floor, named with the level it reported
 * (`details` from the worker). Without the numbers it is still the right
 * sentence, only less specific.
 */
const serverTooOldMessage = (
  server: string,
  details: ErrorDetails | undefined,
  t: PopupT,
): string => {
  const level = details?.apiLevel;
  const min = details?.minApiLevel;
  if (typeof level === "number" && typeof min === "number") {
    return t("errors.serverTooOld", { server, level: String(level), min: String(min) });
  }
  return t("errors.serverTooOldUnknown", { server });
};

export function describeError(
  code: string,
  message: string,
  apiUrl: string,
  t: PopupT,
  details?: ErrorDetails,
): string {
  if (code === "SERVER_TOO_OLD") return serverTooOldMessage(serverHost(apiUrl), details, t);

  if (CREDENTIAL_CODES.has(code)) return t("errors.credentials");

  if (code === "NO_SESSION_TOKEN") return t("errors.noSessionToken");

  if (WORKER_CODES.has(code)) return t("errors.worker");

  if (NETWORK_CODES.has(code) || looksLikeNetworkFailure(message)) {
    return t("errors.unreachable", { server: serverHost(apiUrl) });
  }

  if (/^HTTP_5\d\d$/.test(code)) {
    return t("errors.serverFailed", { status: code.slice(5) });
  }

  return (
    fixedMessage(code, t, serverHost(apiUrl)) ??
    (message.trim() === "" ? t("errors.generic") : message)
  );
}

/**
 * A typed server address the popup refused before asking anyone, in the
 * popup's language. Core's own `message` is English, for Raycast and logs.
 */
export function describeServerInput(
  problem: ServerInputProblem,
  input: string,
  t: PopupT,
): string {
  const trimmed = input.trim();
  switch (problem) {
    case "empty":
      return t("errors.serverEmpty");
    case "invalid-url":
      return t("errors.serverInvalid", { input: trimmed });
    case "insecure": {
      let host = trimmed;
      try {
        host = new URL(trimmed).host;
      } catch {
        /* the typed text is still the best name for it */
      }
      return t("errors.serverInsecure", { host });
    }
  }
}

/** Why the popup's own device sign-in ended, in the popup's language. */
export function describeDeviceSignInError(error: DeviceSignInError, t: PopupT): string {
  switch (error) {
    case "denied":
      return t("errors.deviceDenied");
    case "expired":
      return t("errors.deviceExpired");
    case "failed":
      return t("errors.deviceFailed");
  }
}
