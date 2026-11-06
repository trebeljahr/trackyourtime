/**
 * What better-auth 1.6.33's stock `twoFactor` plugin leaves to the integrator,
 * each observed against the real library before it was written
 * (`tests/two-factor-integration.test.ts`):
 *
 *  1. **A TOTP code verifies once.** The plugin accepts a code for its whole
 *     ±1-step window, as often as it is sent. The guard spends the code's
 *     time step before `/two-factor/verify-totp` runs, and a spent step
 *     answers `INVALID_CODE`, exactly like a wrong code.
 *  2. **The challenge in a header.** `/two-factor/verify-*` finds the
 *     challenge only through the `two_factor` cookie, which the phone and
 *     desktop apps cannot send. The sign-in answer carries it as
 *     `set-two-factor-token` too, and `x-two-factor-token` on a verify is
 *     turned back into that cookie — with no other credential beside it.
 *  3. **A session plus the password is not enough to take over 2FA.** Without
 *     the guard either one re-enables (replacing the secret: the owner's
 *     authenticator stops working and the caller holds the new one), reads
 *     the secret (`get-totp-uri`), disables, or mints new backup codes.
 *     Re-enabling is refused, `get-totp-uri` is 404, and disable, regenerate
 *     and delete account need a code as well, counted per user.
 *  4. **No trusted devices.** `trustDevice` would let the password alone sign
 *     in from that browser for thirty days, and the trust rows outlive
 *     disabling 2FA. It is forced off; `disableSession` is refused.
 *  5. **The cookie cache cannot stand in for a session on `/api/auth`.** A
 *     signed-out or revoked session keeps answering out of the five-minute
 *     `session_data` cookie. The guard looks sessions up with the cache off
 *     and, wherever the two could disagree, fails closed. On every endpoint
 *     but `/get-session`, a request whose cache cookie names a dead session
 *     reaches the endpoint without its session cookies — so device approval
 *     cannot turn a revoked cookie into a fresh thirty-day session.
 *
 * Challenge expiry, replay, five wrong codes per challenge and ten per
 * account are better-auth's own since 1.6.x and are not repeated here.
 *
 * PLUGIN ORDER IS LOAD-BEARING: `twoFactor`, then `bearer`, then this. The
 * after-hook reads the challenge cookie `twoFactor` sets; the before-hooks'
 * `cookie` must win over bearer's rewrite, and the last hook to set a request
 * header wins. See `auth/auth.ts`.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import {
  TWO_FACTOR_ALREADY_ENABLED,
  TWO_FACTOR_CHALLENGE_REQUEST_HEADER,
  TWO_FACTOR_CHALLENGE_RESPONSE_HEADER,
  TWO_FACTOR_CODE_INVALID,
  TWO_FACTOR_CODE_REQUIRED,
  TWO_FACTOR_MAX_STEP_UP_ATTEMPTS,
  TWO_FACTOR_OPTION_NOT_ALLOWED,
  TWO_FACTOR_STEP_UP_ATTEMPT_WINDOW_SECONDS,
  TWO_FACTOR_TOO_MANY_ATTEMPTS,
  looksLikeTotp,
} from "@starter/shared";
import {
  claimAttempt,
  resetAttempts,
  spendTotpCode,
  stepUpAttemptsIdentifier,
  verifySecondFactor,
  writeStepUpMarker,
  type SecondFactorAdapter,
  type SecondFactorContext,
} from "./second-factor.js";

/** better-auth's cookie name suffix for the pending challenge. */
export const TWO_FACTOR_COOKIE = "two_factor";

export const VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

/** better-auth asks only for the password on these; the guard wants a code too. */
export const PASSWORD_AND_CODE_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);

/**
 * 404. `get-totp-uri` hands a session plus the password the secret, a clone
 * of the authenticator; the email OTP routes are not a method offered here
 * (`account-security.ts`).
 */
export const BLOCKED_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/get-totp-uri",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
]);

/**
 * Paths the dead-cached-session strip leaves alone: `/get-session` is what
 * the cookie cache is for (and the guard's own lookups go through it), and
 * every other path here resolves the session with the cache off itself.
 */
export const OWN_SESSION_CHECK_PATHS: ReadonlySet<string> = new Set([
  "/get-session",
  "/two-factor/enable",
  "/delete-user",
  ...VERIFY_PATHS,
  ...PASSWORD_AND_CODE_PATHS,
  ...BLOCKED_PATHS,
]);

/**
 * Paths on which better-auth may create a session for an account with 2FA on.
 * Anything else — Google's callback above all, which the plugin does not
 * intercept — gets no session (`session.create.before` in `auth/auth.ts`).
 *
 *  - `/sign-in/email`: the plugin deletes that session again and answers
 *    with the challenge.
 *  - the two verify paths: the challenge and enrolment.
 *  - `/two-factor/disable`, `/change-password`: replace the caller's own
 *    session, which already came through a verify.
 *  - `/device/token`: approval at `/device` needs a live session.
 *  - `/passkey/verify-authentication`: a passkey with user verification is
 *    two factors on its own (`auth/passkeys.ts`).
 *
 * An allowlist on purpose: a session-minting endpoint a later release adds
 * (or a plugin turned on later) is refused until somebody adds it here.
 */
export const TWO_FACTOR_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  ...VERIFY_PATHS,
  "/two-factor/disable",
  "/change-password",
  "/device/token",
  "/passkey/verify-authentication",
]);

/** The fields of `session.create.before`'s context the allowlist reads. */
export type SessionCreateContext = {
  path?: string;
  context?: {
    internalAdapter?: {
      findUserById: (id: string) => Promise<{ twoFactorEnabled?: boolean | null } | null>;
    };
  };
} | null | undefined;

/**
 * Whether better-auth may create a session for `userId` on this request. A
 * call with no request (a script) is allowed.
 */
export async function sessionCreationAllowed(
  userId: string,
  context: SessionCreateContext,
): Promise<boolean> {
  const path = context?.path;
  if (!path || TWO_FACTOR_SESSION_PATHS.has(path)) return true;
  const user = await context.context?.internalAdapter?.findUserById(userId);
  return user?.twoFactorEnabled !== true;
}

/** The fields of a resolved session the guard reads. */
export type GuardSession = {
  session: { id: string };
  user: { id: string; twoFactorEnabled?: boolean | null };
};

export type TwoFactorGuardDeps = {
  /**
   * The caller's session, looked up with the cookie cache off. A hook cannot
   * resolve a bearer session itself — bearer's header rewrite reaches only
   * the endpoint — so this is `auth.api.getSession` on the real instance.
   */
  getSession: (headers: Headers) => Promise<GuardSession | null>;
};

// --- pure pieces ------------------------------------------------------------

const cookieNameAndValue = (pair: string): { name: string; value: string } => {
  const head = pair.split(";", 1)[0] ?? "";
  const eq = head.indexOf("=");
  return eq < 0
    ? { name: head.trim(), value: "" }
    : { name: head.slice(0, eq).trim(), value: head.slice(eq + 1).trim() };
};

/** The raw (URL-encoded) value of the last non-empty `Set-Cookie` called `name`. */
export function setCookieValue(setCookies: readonly string[], name: string): string | null {
  let found: string | null = null;
  for (const line of setCookies) {
    const cookie = cookieNameAndValue(line);
    if (cookie.name === name && cookie.value) found = cookie.value;
  }
  return found;
}

/** Whether a `Cookie` request header carries `name`, or a chunk of it (`<name>.0`). */
export function hasCookie(cookieHeader: string, name: string): boolean {
  return cookieHeader.split(";").some((pair) => {
    const cookie = cookieNameAndValue(pair).name;
    return cookie === name || cookie.startsWith(`${name}.`);
  });
}

/** A `Cookie` request header without the session token and the cache (and its chunks). */
export function withoutSessionCookies(
  cookieHeader: string,
  names: { sessionToken: string; sessionData: string },
): string {
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const { name } = cookieNameAndValue(pair);
      return !(
        name === names.sessionToken ||
        name === names.sessionData ||
        name.startsWith(`${names.sessionData}.`)
      );
    })
    .join("; ");
}

/** Add header names to an `Access-Control-Expose-Headers` value. */
export function mergeExposeHeaders(existing: string | null, add: readonly string[]): string {
  const names = new Set((existing ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  for (const name of add) names.add(name);
  return [...names].join(", ");
}

/**
 * The challenge identifier inside a signed `two_factor` value
 * (`<identifier>.<signature>`), or `null` when the signature does not match —
 * the check better-call's `getSignedCookie` makes.
 */
export async function unsignChallenge(value: string, secret: string): Promise<string | null> {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const identifier = value.slice(0, dot);
  const expected = await makeSignature(identifier, secret);
  return constantTimeEqual(expected, value.slice(dot + 1)) ? identifier : null;
}

/**
 * The body a verify call runs with: `disableSession: true` refused, and
 * `trustDevice` forced off.
 *
 * `disableSession` on a challenge checks and spends a backup code but creates
 * no session; nothing here needs it. Trusted devices are not offered: the
 * phone and desktop apps never send the trust cookie, and its rows outlive
 * disabling 2FA.
 */
export function sanitizeVerifyBody(body: unknown): Record<string, unknown> {
  const input: Record<string, unknown> =
    typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>) } : {};
  if (input.disableSession === true) {
    throw new APIError("BAD_REQUEST", {
      code: TWO_FACTOR_OPTION_NOT_ALLOWED,
      message: "disableSession is not allowed.",
    });
  }
  input.trustDevice = false;
  return input;
}

// --- errors -----------------------------------------------------------------

const tooManyAttempts = (): APIError =>
  new APIError("TOO_MANY_REQUESTS", {
    code: TWO_FACTOR_TOO_MANY_ATTEMPTS,
    message: "Too many wrong codes. Try again later.",
  });

const invalidChallenge = (): APIError =>
  new APIError("UNAUTHORIZED", { code: "INVALID_TWO_FACTOR_COOKIE", message: "Invalid two factor cookie" });

const invalidPassword = (): APIError =>
  new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" });

/** Answered for a spent TOTP exactly as for a wrong one: a replay learns nothing. */
const spentCode = (): APIError =>
  new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "Invalid code" });

/**
 * Request headers that carry no session but `cookie`. Hook header merges use
 * `Headers.set`, so a header can only be replaced by a value — and this hook
 * runs after bearer's, whose rewrite of `Authorization` it overrides.
 */
const withoutSession = (headers: Headers, cookie: string): Headers => {
  const next = new Headers(headers);
  next.set("authorization", "");
  next.set("cookie", cookie);
  return next;
};

type AccountRow = { providerId?: unknown; password?: unknown };

// --- the plugin -------------------------------------------------------------

export function twoFactorGuard(deps: TwoFactorGuardDeps): BetterAuthPlugin {
  /**
   * Count a TOTP made from inside a session against the user's budget. Only a
   * TOTP: six digits need the budget, a backup code (about 59 bits) does not,
   * and leaving backup codes out keeps the owner's way to disable or
   * regenerate open while somebody holding a session keeps the budget spent.
   */
  const countStepUp = async (adapter: SecondFactorAdapter, userId: string, code: unknown): Promise<void> => {
    if (typeof code !== "string" || !looksLikeTotp(code)) return;
    const allowed = await claimAttempt(adapter, {
      identifier: stepUpAttemptsIdentifier(userId),
      userId,
      max: TWO_FACTOR_MAX_STEP_UP_ATTEMPTS,
      windowSeconds: TWO_FACTOR_STEP_UP_ATTEMPT_WINDOW_SECONDS,
    });
    if (!allowed) throw tooManyAttempts();
  };

  const refuseSpentTotp = async (
    path: string,
    ctx: SecondFactorContext,
    userId: string,
    code: unknown,
  ): Promise<void> => {
    if (path !== "/two-factor/verify-totp" || typeof code !== "string") return;
    if ((await spendTotpCode(ctx, userId, code)) === "already-spent") throw spentCode();
  };

  return {
    id: "trackyourtime-two-factor-guard",
    hooks: {
      before: [
        {
          matcher: (context) => BLOCKED_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async () => {
            throw new APIError("NOT_FOUND");
          }),
        },
        {
          matcher: (context) => VERIFY_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const body = sanitizeVerifyBody(ctx.body);
            const adapter = ctx.context.adapter as unknown as SecondFactorAdapter;
            const factor: SecondFactorContext = { adapter, secretConfig: ctx.context.secretConfig };
            const cookieName = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name;
            const headers = ctx.headers ?? new Headers();
            const fromHeader = headers.get(TWO_FACTOR_CHALLENGE_REQUEST_HEADER);

            // Which path better-auth is about to take: the header forces the
            // challenge; otherwise a live session wins, as in its
            // `verifyTwoFactor`, and the cookie is the fallback.
            let signed: string;
            if (fromHeader) {
              signed = fromHeader;
            } else {
              const session = await deps.getSession(headers);
              if (session) {
                await countStepUp(adapter, session.user.id, body.code);
                await refuseSpentTotp(ctx.path, factor, session.user.id, body.code);
                return { context: { body } };
              }
              const cookie = ctx.getCookie(cookieName);
              // No live session and no challenge. The endpoint would read the
              // cookie cache, and a dead session there would get a free code
              // check — or, mid-enrolment, a fresh session. Fail closed.
              if (!cookie) throw invalidChallenge();
              signed = decodeURIComponent(cookie);
            }

            const challengeId = await unsignChallenge(signed, ctx.context.secret);
            const row = challengeId
              ? await ctx.context.internalAdapter.findVerificationValue(challengeId)
              : null;
            if (row?.value) await refuseSpentTotp(ctx.path, factor, row.value, body.code);

            // The challenge and nothing else: a stale bearer token or a dead
            // cached session beside it would send the endpoint down the
            // session path instead.
            return {
              context: {
                headers: withoutSession(headers, `${cookieName}=${encodeURIComponent(signed)}`),
                body,
              },
            };
          }),
        },
        {
          matcher: (context) => context.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await deps.getSession(ctx.headers ?? new Headers());
            if (!session) throw new APIError("UNAUTHORIZED");
            // The flag or a verified enrolment row: replacing a verified
            // secret takes the authenticator away from its owner.
            const enrolment = await (ctx.context.adapter as unknown as SecondFactorAdapter).findOne<{
              verified?: boolean | null;
            }>({ model: "twoFactor", where: [{ field: "userId", value: session.user.id }] });
            if (session.user.twoFactorEnabled || (enrolment && enrolment.verified !== false)) {
              throw new APIError("BAD_REQUEST", {
                code: TWO_FACTOR_ALREADY_ENABLED,
                message: "Two-factor authentication is already on.",
              });
            }
          }),
        },
        {
          matcher: (context) =>
            PASSWORD_AND_CODE_PATHS.has(context.path ?? "") || context.path === "/delete-user",
          handler: createAuthMiddleware(async (ctx) => {
            const deletion = ctx.path === "/delete-user";
            const session = await deps.getSession(ctx.headers ?? new Headers());
            if (!session) {
              // The endpoints' own middleware may still find a dead session
              // in the cookie cache; delete-user reads the database itself.
              if (deletion) return;
              throw new APIError("UNAUTHORIZED");
            }
            if (deletion && session.user.twoFactorEnabled !== true) return;
            const userId = session.user.id;
            const body = (ctx.body ?? {}) as { password?: unknown; code?: unknown };

            // Password first, so a wrong password never spends a code attempt.
            // Delete-user without one is refused by `account-deletion.ts`.
            if (!deletion || body.password !== undefined) {
              const accounts = (await ctx.context.internalAdapter.findAccounts(userId)) as AccountRow[];
              const hash = accounts.find((account) => account.providerId === "credential")?.password;
              if (
                typeof body.password !== "string" ||
                typeof hash !== "string" ||
                !(await ctx.context.password.verify({ hash, password: body.password }))
              ) {
                throw invalidPassword();
              }
            }

            const adapter = ctx.context.adapter as unknown as SecondFactorAdapter;
            const factor: SecondFactorContext = { adapter, secretConfig: ctx.context.secretConfig };
            if (typeof body.code !== "string" || body.code.trim().length === 0) {
              // Flag on but no enrolment row: a deletion that failed after the
              // cascade removed it. There is nothing to check a code against.
              const enrolled = await adapter.findOne({
                model: "twoFactor",
                where: [{ field: "userId", value: userId }],
              });
              if (!enrolled) return;
              throw new APIError("BAD_REQUEST", {
                code: TWO_FACTOR_CODE_REQUIRED,
                message: "Enter a code from your authenticator app or a backup code.",
              });
            }
            await countStepUp(adapter, userId, body.code);
            const result = await verifySecondFactor(factor, userId, body.code);
            if (result === "invalid") {
              throw new APIError("BAD_REQUEST", {
                code: TWO_FACTOR_CODE_INVALID,
                message: "That code is not valid.",
              });
            }
            await resetAttempts(adapter, stepUpAttemptsIdentifier(userId));
          }),
        },
        {
          // Every other endpoint: a dead session must not answer out of the
          // cookie cache. Only a request carrying the cache cookie can
          // disagree with the database, so only those pay for the lookup.
          matcher: (context) => !OWN_SESSION_CHECK_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.headers;
            const cookieHeader = headers?.get("cookie") ?? "";
            const names = {
              sessionToken: ctx.context.authCookies.sessionToken.name,
              sessionData: ctx.context.authCookies.sessionData.name,
            };
            if (!headers || !hasCookie(cookieHeader, names.sessionData)) return;
            if (await deps.getSession(headers)) return;
            return {
              context: { headers: withoutSession(headers, withoutSessionCookies(cookieHeader, names)) },
            };
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as { twoFactorRedirect?: unknown } | undefined;
            if (!returned || isAPIError(returned) || returned.twoFactorRedirect !== true) return;
            const headers = ctx.context.responseHeaders;
            if (!headers) return;
            headers.delete("set-auth-token");
            const challenge = setCookieValue(
              headers.getSetCookie(),
              ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name,
            );
            if (challenge) headers.set(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER, decodeURIComponent(challenge));
            // better-auth's own expose list replaces the one `cors` set
            // (app.ts), so the header is named here too.
            headers.set(
              "access-control-expose-headers",
              mergeExposeHeaders(headers.get("access-control-expose-headers"), [
                "set-auth-token",
                TWO_FACTOR_CHALLENGE_RESPONSE_HEADER,
              ]),
            );
          }),
        },
        {
          matcher: (context) => VERIFY_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || isAPIError(returned)) return;
            const current = ctx.context.newSession ?? ctx.context.session;
            if (!current?.session) return;
            const adapter = ctx.context.adapter as unknown as SecondFactorAdapter;
            await writeStepUpMarker(adapter, current.session.id, current.user.id);
            await resetAttempts(adapter, stepUpAttemptsIdentifier(current.user.id));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
