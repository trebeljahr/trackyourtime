import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Magic links prove control of a mailbox, but Better Auth's magic-link plugin
 * creates a session without running its two-factor plugin. Check again when
 * the link is redeemed: two-factor can be enabled after the email was sent.
 */
export const magicLinkGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/magic-link/verify") return;

  const token = ctx.query?.token;
  if (typeof token !== "string" || !token) return;
  const identifier = createHash("sha256").update(token).digest("base64url");
  const record = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!record || record.expiresAt < new Date()) return;
  let email: unknown;
  try {
    email = JSON.parse(record.value).email;
  } catch {
    return;
  }
  if (typeof email !== "string") return;
  const account = await ctx.context.internalAdapter.findUserByEmail(email);
  if (account && (account.user as typeof account.user & { twoFactorEnabled?: boolean }).twoFactorEnabled) {
    throw new APIError("FORBIDDEN", {
      message: "Use your password and authenticator to sign in to this account.",
    });
  }
});
