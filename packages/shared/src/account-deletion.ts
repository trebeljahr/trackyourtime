/**
 * The error code `POST /api/auth/delete-user` answers when an account that has
 * a password tried to delete itself without sending it.
 *
 * Shared because the settings dialog branches on it: it is the one refusal
 * that means "ask for the password", as opposed to better-auth's own
 * `INVALID_PASSWORD` ("that password is wrong") and `SESSION_EXPIRED` ("an
 * account with no password must sign in again first").
 */
export const ACCOUNT_DELETION_PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
