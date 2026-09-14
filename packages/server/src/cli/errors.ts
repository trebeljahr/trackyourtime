/**
 * An expected failure of an admin command: a message for the operator, no
 * stack trace. Anything else that reaches the top of `cli/admin.ts` is a bug
 * and is printed in full.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * The message better-auth attached to a refused API call.
 *
 * `auth.api.*` throws its `APIError` with the human-readable text on
 * `body.message` ("Password too short", "User already exists"), while
 * `message` itself can be a bare status name. Prefer the body.
 */
export function authErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: unknown }).body;
    if (typeof body === "object" && body !== null) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}
