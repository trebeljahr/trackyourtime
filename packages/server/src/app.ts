import express, { type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { toNodeHandler } from "better-auth/node";
import { MAX_IMPORT_BYTES } from "@starter/shared";
import { getAuth } from "./auth/auth.js";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import { registerNewsletterRoutes } from "./services/newsletter/routes.js";
import { registerApiV1Routes } from "./api/v1/index.js";
import { isDatabaseReady } from "./db/connection.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { env, getTrustedOrigins } from "./config/env.js";

/**
 * Body ceiling for an import request. {@link MAX_IMPORT_BYTES} of file, plus
 * headroom for JSON escaping of it (a file full of quotes and newlines grows
 * on the way into a JSON string) and the rest of the envelope.
 */
const IMPORT_BODY_LIMIT = `${Math.ceil((MAX_IMPORT_BYTES * 2) / 1_000_000)}mb`;

export function createApp() {
  const app = express();

  // Configurable, not a hardcoded 1: `req.ip` is a security key now (the
  // public API meters failed authentication on it), and a hop count that does
  // not match the deployment breaks it silently in one direction or the other.
  // See TRUST_PROXY_HOPS in config/env.ts and docs/deploy.md.
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  // ── 0. CORS — must be before all route handlers so preflight works ─
  const trustedOrigins = getTrustedOrigins();
  app.use(
    cors({
      origin: trustedOrigins.length > 0 ? trustedOrigins : false,
      credentials: true,
      /**
       * The bearer plugin hands a non-cookie client its session token on
       * `set-auth-token`. A cross-origin caller (the browser extension) can
       * only read that header if it is explicitly exposed.
       */
      exposedHeaders: ["set-auth-token"],
    }),
  );

  // ── 1. better-auth — BEFORE express.json() ────────────────────────
  // better-auth handles its own body parsing. Mounting express.json()
  // before this will consume the body and break auth.
  app.all("/api/auth/{*any}", (req, res, next) => {
    try {
      const auth = getAuth();
      return toNodeHandler(auth)(req, res);
    } catch (err) {
      next(err);
    }
  });

  // ── 2. (Stripe webhook slot) ───────────────────────────────────────
  // This project was scaffolded without the Stripe feature, so there is no
  // services/stripe.ts. If Stripe is added later, its webhook must be
  // mounted HERE — before express.json() — because signature verification
  // needs the raw body.

  // ── 3. Body parsing (for everything else) ──────────────────────────
  //
  // The data-import procedures carry a whole exported file in their body, so
  // they get their own, much larger limit — mounted FIRST, because whichever
  // json() parser runs first consumes the body and the later one is a no-op.
  // Scoped to those procedure names rather than raised globally: 100kb is the
  // right ceiling for every other endpoint, and a limit that only the import
  // path relaxes is a limit an unauthenticated caller cannot reach through any
  // other route. tRPC's batch link puts the procedure names in the path, so a
  // batched call carrying the import still matches.
  const importJson = express.json({ limit: IMPORT_BODY_LIMIT });
  app.use("/api/trpc", (req, res, next) => {
    if (req.path.includes("data.analyze") || req.path.includes("data.commit")) {
      return importJson(req, res, next);
    }
    return next();
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true }));

  // ── 4. Security + logging ──────────────────────────────────────────
  app.use(helmet());
  app.use(morgan(env.isProduction ? "combined" : "dev"));

  // ── 5. tRPC ────────────────────────────────────────────────────────
  // @trpc/server v11's express adapter is typed against @types/express v4
  // while this server runs express v5, so the two RequestHandler shapes do
  // not structurally overlap. The runtime contract is identical — only the
  // type packages differ — hence the double cast.
  const trpcMiddleware = createExpressMiddleware({
    router: appRouter,
    createContext,
  }) as unknown as RequestHandler;
  app.use("/api/trpc", trpcMiddleware);

  // ── 5b. Newsletter (Listmonk + SES double-opt-in subscribe + confirm)
  registerNewsletterRoutes(app);

  // ── 5c. Public REST API (/api/v1) — token-authenticated, never tRPC.
  //
  // Position is load-bearing in three directions:
  //  - AFTER better-auth (1), so nothing here can shadow /api/auth or consume
  //    a request that plugin parses itself.
  //  - AFTER the raw-body slot (2), so it never eats a body that a signature
  //    verification needs to see byte-for-byte.
  //  - AFTER express.json() (3), because these handlers read `req.body`, and
  //    BEFORE the 404/500 handlers (7), which would otherwise answer first.
  registerApiV1Routes(app);

  // ── 6. Health endpoint ─────────────────────────────────────────────
  app.get("/api/health", (req, res) => {
    // Readable from ANY origin. A client choosing a server calls this before
    // it is trusted anywhere — the phone app checking a self-hosted address,
    // the web app checking the server it is about to move to — and a CORS
    // failure would read as "unreachable" when the truth is "reachable, but
    // it does not trust you yet", which is the one thing worth telling them.
    // Nothing here is secret, and no credentials are involved: a trusted
    // origin already got its own `Access-Control-Allow-Origin` from cors()
    // above, and is left alone.
    if (!res.getHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    const origin = req.headers.origin;
    res.json({
      status: "ok",
      // Names the software, so "a server answered" and "a Track Your Time
      // server answered" are different results for a client validating an
      // address somebody typed.
      service: "tracktime",
      release: env.RELEASE,
      // Whether the Origin that asked may sign in here, or null when the
      // request carried none (curl, Raycast). Lets a client say "add this
      // origin to TRUSTED_ORIGINS" instead of failing later with a bare 403.
      originTrusted:
        typeof origin === "string"
          ? getTrustedOrigins().includes(origin)
          : null,
      db: isDatabaseReady(),
      // Where this API's web app lives. The browser extension has only an API
      // URL configured, and needs somewhere to send "Open Track Your Time" — asking
      // the server beats making the user configure a second URL that must
      // agree with the first. Public, but FRONTEND_URL is a public address.
      webUrl: env.FRONTEND_URL,
      // The commit this image was built from. The deploy pipeline polls this
      // until it matches the commit it just pushed — without it, a deploy that
      // silently kept the previous container reported success everywhere.
      // Empty for a locally-run server, which has no build commit.
      version: env.COMMIT_SHA,
      timestamp: new Date().toISOString(),
    });
  });

  // ── 7. Error handlers (must be last) ───────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
