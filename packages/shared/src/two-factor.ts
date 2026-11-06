/**
 * The two-factor wire contract between the server's guard
 * (`packages/server/src/auth/two-factor-guard.ts`) and every client.
 *
 * Clients branch on these codes, never on a message.
 */

/**
 * The sign-in challenge, for clients that cannot carry better-auth's
 * `two_factor` cookie (the phone and desktop apps). A 2FA sign-in answers with
 * the signed challenge in this response header; the client sends it back,
 * byte for byte, in {@link TWO_FACTOR_CHALLENGE_REQUEST_HEADER} on
 * `/two-factor/verify-totp` or `/two-factor/verify-backup-code`.
 */
export const TWO_FACTOR_CHALLENGE_RESPONSE_HEADER = "set-two-factor-token";
export const TWO_FACTOR_CHALLENGE_REQUEST_HEADER = "x-two-factor-token";

/**
 * Google sign-in for an account with two-factor on ends on the web app's
 * `/login?two_factor=1`, with the challenge in the API's `two_factor` cookie:
 * the login page shows the code step, and the verify call carries the cookie.
 */
export const TWO_FACTOR_SOCIAL_PARAM = "two_factor";

/** `/two-factor/enable` on an account that already has two-factor on. */
export const TWO_FACTOR_ALREADY_ENABLED = "TWO_FACTOR_ALREADY_ENABLED";
/** Disable, regenerate backup codes or delete account was sent no code. */
export const TWO_FACTOR_CODE_REQUIRED = "TWO_FACTOR_CODE_REQUIRED";
/** The code sent to disable, regenerate or delete account is not valid. */
export const TWO_FACTOR_CODE_INVALID = "TWO_FACTOR_CODE_INVALID";
/** Too many wrong authenticator codes from inside a session. */
export const TWO_FACTOR_TOO_MANY_ATTEMPTS = "TWO_FACTOR_TOO_MANY_ATTEMPTS";
/** A verify option the server does not offer (`disableSession`). */
export const TWO_FACTOR_OPTION_NOT_ALLOWED = "TWO_FACTOR_OPTION_NOT_ALLOWED";
/**
 * The tRPC message of the FORBIDDEN that `apiTokens.create` answers when a
 * 2FA account's session has not verified a code recently. The client verifies
 * one inside the session and retries the same input.
 */
export const TWO_FACTOR_STEP_UP_REQUIRED = "TWO_FACTOR_STEP_UP_REQUIRED";

/** How long a verified code lets a session mint an API token. */
export const TWO_FACTOR_STEP_UP_SECONDS = 10 * 60;
/** Wrong authenticator codes from inside a session, per user and window. */
export const TWO_FACTOR_MAX_STEP_UP_ATTEMPTS = 10;
export const TWO_FACTOR_STEP_UP_ATTEMPT_WINDOW_SECONDS = 15 * 60;

/**
 * Whether a code is shaped like an authenticator code (six digits, spaces
 * allowed) rather than a backup code. Disable, regenerate and delete account
 * take either in one field.
 */
export const looksLikeTotp = (code: string): boolean => /^\d{6}$/.test(code.replace(/\s+/g, ""));
