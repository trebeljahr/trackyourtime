/**
 * Server helpers for the second factor that better-auth's `twoFactor` plugin
 * does not have: checking a code outside its endpoints, spending a TOTP time
 * step once, counting wrong codes made from inside a session, and the
 * "recently verified" marker that `apiTokens.create` asks for.
 *
 * Everything is a row in better-auth's own `verification` table, written
 * through its adapter, named `2fa-…` and carrying the user id in `value`. That
 * is what lets `admin reset-two-factor` clear one person's rows with
 * `{ value: userId }` and an identifier prefix, on Mongo and in the in-memory
 * test adapter alike. Every row expires within fifteen minutes on its own.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DBAdapter } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import {
  TWO_FACTOR_STEP_UP_SECONDS,
  looksLikeTotp,
} from "@starter/shared";

/** The slice of better-auth's `DBAdapter` these helpers use. */
export type SecondFactorAdapter = Pick<
  DBAdapter,
  "findOne" | "findMany" | "create" | "delete" | "deleteMany"
>;

/** What reading an enrolment needs from better-auth's `AuthContext`. */
export type SecondFactorContext = {
  adapter: SecondFactorAdapter;
  /** `ctx.context.secretConfig`: the key the plugin encrypted the secret with. */
  secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"];
};

/** `not-enrolled`: no `twoFactor` row, so there is nothing to check against. */
export type SecondFactorResult = "totp" | "backup-code" | "invalid" | "not-enrolled";

type TwoFactorRow = { secret: string; backupCodes: string };

type VerificationRow = {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date | string;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * The plugin's TOTP shape. `account-security.ts` leaves `totpOptions` at
 * better-auth's defaults, and `@better-auth/utils`' verify accepts one step
 * either side of the current one.
 */
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW_STEPS = 1;

/** RFC 4226 HOTP over the decrypted secret's bytes, as `createOTP` computes it. */
export function hotp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(value).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step `code` belongs to, within the window better-auth's own verify
 * accepts, or `null` when it matches none.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  now: number = Date.now(),
): number | null {
  const current = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000));
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    if (hotp(secret, current + offset) === code) return current + offset;
  }
  return null;
}

const toTime = (value: Date | string): number => new Date(value).getTime();

async function liveRows(
  adapter: SecondFactorAdapter,
  identifier: string,
  now: number,
): Promise<VerificationRow[]> {
  const rows = await adapter.findMany<VerificationRow>({
    model: "verification",
    where: [{ field: "identifier", value: identifier }],
    limit: 1000,
  });
  // better-auth hands back expired rows; the expiry is ours to check.
  return rows.filter((row) => toTime(row.expiresAt) > now);
}

/** How many attempts are counted against `identifier` right now. */
export async function readAttempts(
  adapter: SecondFactorAdapter,
  identifier: string,
  now: number = Date.now(),
): Promise<number> {
  return (await liveRows(adapter, identifier, now)).length;
}

/**
 * Count this attempt BEFORE the code is checked, and say whether it is within
 * the budget.
 *
 * Writing first and counting second is the point: counting first and
 * recording failures afterwards lets a parallel burst all read "0 so far".
 * Here the k-th row to land reads at least k, so no more than `max` attempts
 * ever reach a code check, however many arrive at once. An attempt over the
 * budget removes its own row again, so hammering a full counter does not keep
 * extending it. One row per attempt, each expiring `windowSeconds` after it
 * was made: a sliding window that needs no atomic increment.
 */
export async function claimAttempt(
  adapter: SecondFactorAdapter,
  args: { identifier: string; userId: string; max: number; windowSeconds: number; now?: number },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const created = await adapter.create<VerificationRow>({
    model: "verification",
    data: {
      identifier: args.identifier,
      value: args.userId,
      expiresAt: new Date(now + args.windowSeconds * 1000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  });
  if ((await readAttempts(adapter, args.identifier, now)) <= args.max) return true;
  await adapter.delete({ model: "verification", where: [{ field: "id", value: created.id }] });
  return false;
}

/** Forget every attempt counted against `identifier`. */
export async function resetAttempts(adapter: SecondFactorAdapter, identifier: string): Promise<void> {
  await adapter.deleteMany({ model: "verification", where: [{ field: "identifier", value: identifier }] });
}

/** Wrong authenticator codes made from inside a session, per user. */
export const stepUpAttemptsIdentifier = (userId: string): string => `2fa-attempts-step-up-${userId}`;

export const spentTotpStepIdentifier = (userId: string, step: number): string =>
  `2fa-totp-spent-${userId}-${step}`;

/**
 * Spend one TOTP time step for `userId`: `true` the first time, `false` while
 * any window could still accept it.
 *
 * Without this a code is good for its whole ±1-step window, so one seen over
 * a shoulder, on a shared screen or through a phishing proxy signs in a
 * second time with the password (RFC 6238 §5.2: accept an OTP once). A budget
 * of one on the same claim-before-count rows, so of two parallel uses at most
 * one passes (and if both land at once, neither does: fail closed, the owner
 * types the next code).
 */
export async function spendTotpStep(
  adapter: SecondFactorAdapter,
  userId: string,
  step: number,
  now: number = Date.now(),
): Promise<boolean> {
  const lastAcceptedAt = (step + TOTP_WINDOW_STEPS + 1) * TOTP_PERIOD_SECONDS * 1000;
  return claimAttempt(adapter, {
    identifier: spentTotpStepIdentifier(userId, step),
    userId,
    max: 1,
    windowSeconds: Math.max(1, Math.ceil((lastAcceptedAt - now) / 1000)),
    now,
  });
}

async function enrolmentOf(ctx: SecondFactorContext, userId: string): Promise<TwoFactorRow | null> {
  return ctx.adapter.findOne<TwoFactorRow>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });
}

/**
 * Before `/two-factor/verify-totp` checks `code`: spend its step, or say it
 * was spent already. `unchecked` when the code matches no step or there is no
 * enrolment to check it against — the endpoint answers those itself.
 */
export async function spendTotpCode(
  ctx: SecondFactorContext,
  userId: string,
  code: string,
): Promise<"spent" | "already-spent" | "unchecked"> {
  const row = await enrolmentOf(ctx, userId);
  if (!row) return "unchecked";
  let secret: string;
  try {
    secret = await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
  } catch {
    return "unchecked";
  }
  const step = matchTotpStep(secret, code.replace(/\s+/g, ""));
  if (step === null) return "unchecked";
  return (await spendTotpStep(ctx.adapter, userId, step)) ? "spent" : "already-spent";
}

/**
 * Whether `code` is a current, unspent TOTP or one of the user's backup codes.
 * For disable, regenerate and delete account, which better-auth gates on the
 * password alone.
 *
 * A TOTP spends its step. A backup code is not consumed here: disable and
 * delete remove the enrolment, and regenerate replaces every backup code. A
 * secret that no longer decrypts (`BETTER_AUTH_SECRET` changed) reads as
 * `invalid`, exactly what the person sees at sign-in too.
 */
export async function verifySecondFactor(
  ctx: SecondFactorContext,
  userId: string,
  code: string,
): Promise<SecondFactorResult> {
  const row = await enrolmentOf(ctx, userId);
  if (!row) return "not-enrolled";
  try {
    if (looksLikeTotp(code)) {
      const secret = await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
      const step = matchTotpStep(secret, code.replace(/\s+/g, ""));
      if (step === null) return "invalid";
      return (await spendTotpStep(ctx.adapter, userId, step)) ? "totp" : "invalid";
    }
    const codes: unknown = JSON.parse(
      await symmetricDecrypt({ key: ctx.secretConfig, data: row.backupCodes }),
    );
    return Array.isArray(codes) && codes.includes(code.trim()) ? "backup-code" : "invalid";
  } catch {
    return "invalid";
  }
}

// --- step-up marker ---------------------------------------------------------

export const stepUpMarkerIdentifier = (sessionId: string): string => `2fa-fresh-${sessionId}`;

/**
 * Record that `sessionId` has just passed a second factor. Written on every
 * successful verify, whether it created the session (sign-in, enrolment) or
 * proved the factor again inside it (step-up).
 */
export async function writeStepUpMarker(
  adapter: SecondFactorAdapter,
  sessionId: string,
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  const identifier = stepUpMarkerIdentifier(sessionId);
  await resetAttempts(adapter, identifier);
  await adapter.create({
    model: "verification",
    data: {
      identifier,
      value: userId,
      expiresAt: new Date(now + TWO_FACTOR_STEP_UP_SECONDS * 1000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  });
}

/** Whether `sessionId` passed a second factor within the step-up window. */
export async function hasLiveStepUp(
  adapter: SecondFactorAdapter,
  sessionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await liveRows(adapter, stepUpMarkerIdentifier(sessionId), now)).length > 0;
}

// --- trusted browsers -------------------------------------------------------

/** better-auth's identifier prefix for a "Trust this browser" row. */
export const TRUSTED_BROWSER_PREFIX = "trust-device-";

/**
 * Forget every browser this user trusted. better-auth deletes only the one
 * whose cookie a request carries; the rest would keep skipping the code for
 * up to TWO_FACTOR_TRUST_DAYS after a password change, after turning 2FA off
 * and on again, after "sign out everywhere".
 */
export async function forgetTrustedBrowsers(adapter: SecondFactorAdapter, userId: string): Promise<number> {
  const rows = await adapter.findMany<VerificationRow>({
    model: "verification",
    where: [{ field: "value", value: userId }],
    limit: 1000,
  });
  const trusted = rows.filter((row) => row.identifier.startsWith(TRUSTED_BROWSER_PREFIX));
  for (const row of trusted) {
    await adapter.delete({ model: "verification", where: [{ field: "id", value: row.id }] });
  }
  return trusted.length;
}

/**
 * Whether the signed `trust_device` cookie value (`<hmac>!<identifier>`)
 * trusts this browser for `userId`: the HMAC better-auth writes, over
 * `<userId>!<identifier>` with the instance secret, and a live row naming the
 * user — the same checks its own sign-in hook makes.
 */
export async function isTrustedBrowser(
  findVerificationValue: (identifier: string) => Promise<{ value: string; expiresAt: Date | string } | null | undefined>,
  secret: string,
  userId: string,
  cookieValue: string | null | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!cookieValue) return false;
  const [token, identifier] = cookieValue.split("!");
  if (!token || !identifier?.startsWith(TRUSTED_BROWSER_PREFIX)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${userId}!${identifier}`).digest("base64url"));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const row = await findVerificationValue(identifier);
  return !!row && row.value === userId && toTime(row.expiresAt) > now;
}
