import { router, publicProcedure } from "../trpc.js";
import { isDatabaseReady } from "../../db/connection.js";
import { env } from "../../config/env.js";
import { isEmailDeliveryConfigured } from "../../services/email.js";
import { resolveAuthConfig } from "../../auth/account-security.js";
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from "@starter/shared";

export const healthRouter = router({
  check: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      db: isDatabaseReady(),
      timestamp: new Date().toISOString(),
      /** The same handshake fields as `/api/health`; see app.ts. */
      release: env.RELEASE,
      apiLevel: API_LEVEL,
      minClientApiLevel: MIN_CLIENT_API_LEVEL,
      commit: env.COMMIT_SHA,
      /**
       * Public on purpose: /login and /signup read it before anyone is signed
       * in, to decide whether the Google button is live and whether a new
       * account has to confirm its email. Two booleans, no configuration
       * values.
       */
      authConfig: resolveAuthConfig({
        googleClientId: env.GOOGLE_CLIENT_ID,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET,
        emailDeliveryConfigured: isEmailDeliveryConfigured(),
      }),
    };
  }),
});
