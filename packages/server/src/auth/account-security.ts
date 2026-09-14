/**
 * Two-factor sign-in, email verification and the account controls built on
 * them — the pieces `auth/auth.ts` registers, kept here so
 * `tests/two-factor-integration.test.ts` runs exactly this configuration
 * against the real library instead of a copy of it.
 *
 * Nothing in this file reads `config/env.ts`: every environment-dependent
 * answer is passed in, so the test can build an instance with no server
 * environment at all.
 *
 * Four things here fail quietly if changed:
 *
 *  - **`twoFactor()` must be registered BEFORE `bearer()`.** better-auth runs
 *    plugin `after` hooks in registration order. Password sign-in creates a
 *    real session first; the two-factor hook then deletes it, expires its
 *    cookie and answers `{ twoFactorRedirect: true }`. If the bearer hook ran
 *    first it would read the still-live cookie and hand out `set-auth-token`
 *    for a session that is deleted a moment later — the extension would store
 *    a token that answers 401 everywhere. In this order the bearer hook sees
 *    an expired cookie and emits nothing, so a token client gets an error.
 *  - **The challenge is a signed cookie** (`better-auth.two_factor`), and
 *    `/two-factor/verify-*` reads nothing else. A browser carries it for free.
 *    A WKWebView or extension `fetch` can neither read `set-cookie` nor send
 *    `Cookie`, so the native shells and the extension cannot complete the
 *    challenge bearer-only with this configuration. The integration test pins
 *    both halves: without the cookie the verify is refused; with the cookie
 *    forwarded by hand it yields a session and a bearer token. Carrying the
 *    challenge in a header is the native-clients follow-up, not a switch here.
 *  - **Email verification is required only when mail can be delivered.** A
 *    self-host without a transport would otherwise lock every new account out
 *    behind a link that goes nowhere but the server log. Accounts that existed
 *    before are marked verified once, by `scripts/backfill-email-verified.ts`.
 *  - **No auto sign-in after verification.** A verification link is not a
 *    second factor; signing in from it would hand a session to someone who
 *    has only the password.
 */
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";

/** The account name an authenticator app shows beside the code. */
export const TWO_FACTOR_ISSUER = "Track Your Time";

/** What the sign-in and settings screens need to know before enabling controls. */
export type AuthConfig = {
  /** Google sign-in is configured on this server. */
  googleEnabled: boolean;
  /** New accounts and email changes are confirmed by a mailed link. */
  emailVerificationRequired: boolean;
};

export function resolveAuthConfig(source: {
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  emailDeliveryConfigured: boolean;
}): AuthConfig {
  return {
    googleEnabled: Boolean(source.googleClientId && source.googleClientSecret),
    emailVerificationRequired: source.emailDeliveryConfigured,
  };
}

/**
 * The configured two-factor plugin: TOTP plus single-use backup codes.
 *
 * - One-time codes by email are not offered (`otpOptions` unset): the
 *   mailbox is where a password reset already goes, so it is no second factor.
 * - Enabling does not switch 2FA on. `/two-factor/enable` stores the secret
 *   and returns the URI and backup codes; `twoFactorEnabled` becomes true
 *   only once a code from the authenticator verifies, so a QR code that was
 *   never scanned cannot lock anyone out.
 * - Backup codes are stored encrypted (the library default) and shown once.
 */
export function twoFactorPlugin(): ReturnType<typeof twoFactor> {
  return twoFactor({ issuer: TWO_FACTOR_ISSUER });
}

export type AuthMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * Delivers one auth mail. `auth/auth.ts` passes the function that sends
 * through `sendEmail` and logs the URL when no transport is configured.
 */
export type AuthMailSender = (url: string, mail: AuthMail) => Promise<void>;

/**
 * The `emailVerification` block for `betterAuth()`.
 *
 * `sendVerificationEmail` also carries change-email links: better-auth mails
 * the NEW address and switches the email only when that link is followed,
 * which proves the person controls the address they asked for.
 */
export function emailVerificationOptions(send: AuthMailSender): {
  sendOnSignUp: boolean;
  sendOnSignIn: boolean;
  autoSignInAfterVerification: boolean;
  sendVerificationEmail: (data: { user: { email: string }; url: string }) => Promise<void>;
} {
  return {
    sendOnSignUp: true,
    // /login asks for the link itself (`sendVerificationEmail`) so it can
    // point it at the web app: the sign-in body's `callbackURL` would do the
    // same, but better-auth's client follows that URL as a redirect.
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    async sendVerificationEmail({ user, url }) {
      await send(url, {
        to: user.email,
        subject: "Verify your email address",
        text: `Open this link to verify your email address: ${url}`,
        html: `<p><a href="${url}">Verify your email address</a></p>`,
      });
    },
  };
}

/**
 * Endpoints after which some of this person's sessions no longer exist.
 *
 * `ws/session-watch.ts` closes those sockets with 4401 within one interval on
 * its own; sweeping at once makes "sign out other devices" land now. The
 * sweep is best effort — the interval is the guarantee.
 */
export const SESSION_REVOKING_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

export const sweepSocketsAfterRevocation = (
  sweep: () => void,
): ReturnType<typeof createAuthMiddleware> =>
  createAuthMiddleware(async (ctx) => {
    if (SESSION_REVOKING_PATHS.has(ctx.path)) sweep();
  });
