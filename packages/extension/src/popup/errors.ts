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

import { serverHost } from "@starter/core";

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
const fixedMessage = (code: string, t: PopupT): string | null => {
  switch (code) {
    case "INVALID_EMAIL":
      return t("errors.invalidEmail");
    case "EMAIL_NOT_VERIFIED":
      return t("errors.emailNotVerified");
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

export function describeError(
  code: string,
  message: string,
  apiUrl: string,
  t: PopupT,
): string {
  if (CREDENTIAL_CODES.has(code)) return t("errors.credentials");

  if (code === "NO_SESSION_TOKEN") return t("errors.noSessionToken");

  if (WORKER_CODES.has(code)) return t("errors.worker");

  if (NETWORK_CODES.has(code) || looksLikeNetworkFailure(message)) {
    return t("errors.unreachable", { server: serverHost(apiUrl) });
  }

  if (/^HTTP_5\d\d$/.test(code)) {
    return t("errors.serverFailed", { status: code.slice(5) });
  }

  return fixedMessage(code, t) ?? (message.trim() === "" ? t("errors.generic") : message);
}
