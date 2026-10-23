import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** Bind credentials to this installation's web origin, including self-hosts. */
export function passkeyPlugin(frontendUrl: string) {
  const origin = new URL(frontendUrl);
  const plugin = passkey({
    rpID: origin.hostname,
    rpName: "Track Your Time",
    origin: origin.origin,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    registration: {
      afterVerification: async ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) throw new APIError("UNAUTHORIZED", { message: "Passkey user verification is required." });
      },
    },
    authentication: {
      // The plugin verifies signatures but defaults to accepting presence
      // without user verification. Unlock requires the authenticator's PIN
      // or biometric check, including on already enrolled security keys.
      afterVerification: async ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) {
          throw new APIError("UNAUTHORIZED", { message: "Passkey user verification is required." });
        }
      },
    },
  });
  return { ...plugin, hooks: { after: [{
    matcher: (ctx) => ctx.path === "/passkey/generate-authenticate-options",
    handler: createAuthMiddleware(async (ctx) => {
      const options = ctx.context.returned;
      if (options && typeof options === "object" && "challenge" in options) return ctx.json({ ...options, userVerification: "required" });
    }),
  }] } } satisfies BetterAuthPlugin;
}
