import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { parseSessionOutput } from "better-auth/db";

/** Install after two-factor: a challenge must never expose a session. */
export const loginSessionPlugin = (): BetterAuthPlugin => ({
  id: "login-session",
  hooks: {
    after: [{
      matcher: (ctx) => ctx.path === "/sign-in/email",
      handler: createAuthMiddleware(async (ctx) => {
        const issued = ctx.context.newSession;
        const result = ctx.context.returned;
        if (!issued || !result || typeof result !== "object" ||
            !("token" in result) || result.token !== issued.session.token) return;
        return ctx.json({
          ...result,
          session: parseSessionOutput(ctx.context.options, issued.session),
        });
      }),
    }],
  },
});
