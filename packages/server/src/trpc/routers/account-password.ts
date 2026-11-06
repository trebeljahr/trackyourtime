import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { passwordKdfSchema } from "@starter/shared";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { env } from "../../config/env.js";
import { getAuth } from "../../auth/auth.js";
import { normalizeLoginEmail, passwordKdfFor, PasswordUpgradeRefused, upgradeToLoginSecret, type PasswordUpgradeContext } from "../../auth/password-kdf.js";

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

  upgrade: protectedProcedure
    .input(z.object({ current: z.string().min(1).max(1024), loginSecret: z.string().max(128), kdf: passwordKdfSchema }).strict())
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
});
