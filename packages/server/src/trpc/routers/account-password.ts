import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { passwordKdfSchema } from "@starter/shared";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { env } from "../../config/env.js";
import { getAuth } from "../../auth/auth.js";
import { clearPasswordKeysStale, normalizeLoginEmail, parsePasswordKdf, passwordKdfFor, passwordKeysStale, PasswordUpgradeRefused, upgradeToLoginSecret, verifyLoginSecret, type PasswordUpgradeContext } from "../../auth/password-kdf.js";

/** Password checks outside sign-in: at most 10 per user in 15 minutes, per process. */
const VERIFY_WINDOW_MS = 15 * 60_000, VERIFY_LIMIT = 10;
const verifyAttempts = new Map<string, { since: number; count: number }>();
function allowVerify(userId: string, now = Date.now()): boolean {
  const seen = verifyAttempts.get(userId);
  if (!seen || now - seen.since > VERIFY_WINDOW_MS) { verifyAttempts.set(userId, { since: now, count: 1 }); return true; }
  seen.count++; return seen.count <= VERIFY_LIMIT;
}

/**
 * Password unlock (auth/password-kdf.ts). `kdf` is public on purpose: clients
 * need the parameters before they can derive what to sign in with, and
 * unknown emails get stable decoys, so the answer says nothing about whether
 * an account exists (except during the short legacy window).
 */
export const accountPasswordRouter = router({
  kdf: publicProcedure
    .input(z.object({ email: z.string().trim().min(3).max(320) }).strict())
    .query(async ({ input }) => {
      const context = await getAuth().$context;
      const found = await context.internalAdapter.findUserByEmail(normalizeLoginEmail(input.email), { includeAccounts: true });
      const hasPassword = !!found?.accounts?.some((account: { providerId: string; password?: string | null }) => account.providerId === "credential" && !!account.password);
      return passwordKdfFor(input.email, (found?.user ?? null) as Record<string, unknown> | null, hasPassword, env.BETTER_AUTH_SECRET);
    }),

  /** The reset page derives the new password under the account's existing
   * parameters. Null for an invalid/expired link or a legacy account, which
   * then resets with the typed password as before. Possession of the link
   * is the authorization; the parameters themselves are not secret. */
  kdfForReset: publicProcedure
    .input(z.object({ token: z.string().min(1).max(512) }).strict())
    .query(async ({ input }) => {
      const context = await getAuth().$context;
      const verification = await context.internalAdapter.findVerificationValue(`reset-password:${input.token}`);
      if (!verification || new Date(verification.expiresAt).getTime() < Date.now()) return null;
      const user = await context.internalAdapter.findUserById(verification.value);
      return parsePasswordKdf((user as Record<string, unknown> | null)?.passwordKdf);
    }),

  upgrade: protectedProcedure
    .input(z.object({ current: z.string().min(1).max(1024), loginSecret: z.string().max(128), kdf: passwordKdfSchema }))
    .mutation(async ({ ctx, input }) => {
      const context = await getAuth().$context;
      try {
        await upgradeToLoginSecret(context as unknown as PasswordUpgradeContext, ctx.user.id, input);
      } catch (error) {
        if (error instanceof PasswordUpgradeRefused) {
          throw new TRPCError({ code: error.reason === "wrong-password" ? "UNAUTHORIZED" : "PRECONDITION_FAILED", message: `password-upgrade-${error.reason}` });
        }
        throw error;
      }
      return { ok: true as const };
    }),

  /** After a password reset the keys' password envelope is stale until a
   * device that holds the keys seals them again (`keysRewrapped`). */
  keysStatus: protectedProcedure.query(async ({ ctx }) => {
    const context = await getAuth().$context;
    return { stale: await passwordKeysStale(context as unknown as PasswordUpgradeContext, ctx.user.id) };
  }),

  /** Checks a derived login secret before a device seals the keys under it,
   * so a typo cannot replace the envelope with one nobody can open. */
  verify: protectedProcedure
    // Not strict: the app's tRPC link adds its workspaceId to every input.
    .input(z.object({ loginSecret: z.string().max(128) }))
    .mutation(async ({ ctx, input }) => {
      if (!allowVerify(ctx.user.id)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "password-verify-rate-limited" });
      const context = await getAuth().$context;
      return { ok: await verifyLoginSecret(context as unknown as PasswordUpgradeContext, ctx.user.id, input.loginSecret) };
    }),

  keysRewrapped: protectedProcedure.mutation(async ({ ctx }) => {
    const context = await getAuth().$context;
    await clearPasswordKeysStale(context as unknown as PasswordUpgradeContext, ctx.user.id);
    return { ok: true as const };
  }),
});
