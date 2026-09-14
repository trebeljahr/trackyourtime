/**
 * Turn a {@link BackgroundResponse} failure into something a user can act on.
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
 * Anything unrecognised falls through to the worker's own message rather than
 * a generic apology, so a new server-side code still says something true.
 */

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

export function describeError(
  code: string,
  message: string,
  apiUrl: string,
): string {
  if (CREDENTIAL_CODES.has(code)) {
    return "That email and password did not match an account.";
  }

  if (code === "NO_SESSION_TOKEN") {
    return (
      "The server accepted the password but returned no session token, so " +
      "there is nothing for the extension to keep. Its better-auth bearer " +
      "plugin needs to be enabled — signing in again will not help."
    );
  }

  if (WORKER_CODES.has(code)) {
    return "The extension's background worker did not answer. Close and reopen the popup.";
  }

  if (NETWORK_CODES.has(code) || looksLikeNetworkFailure(message)) {
    return `Could not reach ${serverHost(apiUrl)}. Check the server address and that the server is running.`;
  }

  if (/^HTTP_5\d\d$/.test(code)) {
    return `The server failed with ${code.slice(5)}. Try again in a moment.`;
  }

  return message;
}
