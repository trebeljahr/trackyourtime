import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * The verification row's identifier for a magic-link token under
 * `storeToken: "hashed"`. better-auth 1.7 prefixes it with `magic-link:`; a
 * lookup by the bare hash finds nothing and lets the link through, so
 * `magic-link-integration.test.ts` pins this against the row the plugin writes.
 */
export const magicLinkVerificationIdentifier = (token: string): string =>
  `magic-link:${createHash("sha256").update(token).digest("base64url")}`;

/**
 * Magic links prove control of a mailbox, but Better Auth's magic-link plugin
 * creates a session without running its two-factor plugin. Check again when
 * the link is redeemed: two-factor can be enabled after the email was sent.
 */
export const magicLinkGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/magic-link/verify") return;

  const token = ctx.query?.token;
  if (typeof token !== "string" || !token) return;
  const record = await ctx.context.internalAdapter.findVerificationValue(
    magicLinkVerificationIdentifier(token),
  );
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
