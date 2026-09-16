/**
 * Turning anything thrown inside the worker into the one shape the popup can
 * render: `{ ok: false, code, message }`.
 *
 * The popup prints `message` verbatim, so two rules hold everywhere in here:
 * the string has to tell a human what to do next, and it must never contain a
 * token, a password, or a raw auth response.
 */
import { ApiError, AuthError } from "@starter/core";
import type { BackgroundResponse, ErrorDetails } from "../lib/messaging";

/** A failure the worker itself decided on, rather than one the server sent. */
export class BackgroundError extends Error {
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "BackgroundError";
    this.code = code;
    this.details = details;
  }
}

/**
 * better-auth's codes are machine-readable but not readable. Only the ones a
 * user can actually act on are rewritten; anything else keeps the server's own
 * message, which is more informative than a generic fallback would be.
 */
const AUTH_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match an account.",
  USER_NOT_FOUND: "That email and password don't match an account.",
  INVALID_EMAIL: "That doesn't look like an email address.",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in.",
  NO_SESSION_TOKEN:
    "The server accepted the sign-in but issued no session token.",
  NO_FETCH: "This browser could not make the request.",
};

const UNREACHABLE =
  "Could not reach the server. Check its address and that it is running.";

/**
 * A rejection that never carried an HTTP response — `fetch` throws a
 * `TypeError` when it cannot reach the host at all, and both `ApiError` and
 * `AuthError` are only ever constructed after a response came back. So
 * "neither of those" is a precise test for a dead network, with no message
 * sniffing involved.
 */
const isUnreachable = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof DOMException && error.name === "NetworkError");

export const toErrorResponse = (error: unknown): BackgroundResponse => {
  if (error instanceof AuthError) {
    return {
      ok: false,
      code: error.code,
      message: AUTH_MESSAGES[error.code] ?? error.message,
    };
  }

  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message };
  }

  if (error instanceof BackgroundError) {
    return error.details === undefined
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: error.code, message: error.message, details: error.details };
  }

  if (isUnreachable(error)) {
    return { ok: false, code: "UNREACHABLE", message: UNREACHABLE };
  }

  return {
    ok: false,
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : "Something went wrong.",
  };
};
