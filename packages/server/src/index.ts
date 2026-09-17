// Sentry must be imported first
import "./instrument.js";

import { createServer } from "http";
import { createApp } from "./app.js";
import { connectToDB, disconnectFromDB } from "./db/connection.js";
import { BootRefusedError, prepareDatabase } from "./db/prepare.js";
import { SchemaTooNewError } from "./services/migrations/index.js";
import { connectRedis, disconnectRedis } from "./db/redis.js";
import { initAuth, disconnectAuth } from "./auth/auth.js";
import { setupWebSocket } from "./ws/handler.js";
import { startWebhookSweeper } from "./services/webhooks/sweeper.js";
import {
  registerBuiltInJobs,
  startScheduler,
  stopScheduler,
} from "./services/scheduler/index.js";
import { env, getTrustedOrigins } from "./config/env.js";

const app = createApp();
const server = createServer(app);
const wss = setupWebSocket(server);

async function start(): Promise<void> {
  try {
    // 1. Connect to databases
    await connectToDB();
    // Refuse a database migrated by a newer release, apply pending
    // migrations under a lock, then build and check every index. Before
    // anything else reads or writes, and long before listen.
    await prepareDatabase();
    await connectRedis();

    // 2. Initialize auth (needs DB connection)
    await initAuth();

    // 3. Start the webhook delivery loop. After initAuth() because a
    //    delivery resolves the subscription owner's membership before it
    //    decides what that owner may see. No-op under NODE_ENV=test.
    startWebhookSweeper();

    // 4. Start the job scheduler (runaway-timer enforcement and reminders).
    //    After the DB connects because every poll is a claim on a job row.
    //    Gated by SCHEDULER_ENABLED; no-op under NODE_ENV=test.
    registerBuiltInJobs();
    if (startScheduler({ enabled: env.SCHEDULER_ENABLED, isTest: env.isTest })) {
      console.log("[scheduler] Started");
    } else if (!env.isTest) {
      console.log("[scheduler] Disabled by SCHEDULER_ENABLED");
    }

    // 5. Start listening
    server.listen(env.PORT, () => {
      console.log(`[server] Listening on http://127.0.0.1:${env.PORT}`);
      console.log(`[server] Environment: ${env.NODE_ENV}`);
      // Printed, not inferred. This list is read once at boot by both CORS
      // (app.ts) and better-auth (auth.ts), so an env edit without a restart
      // changes nothing — and an origin missing from it is answered with
      // `403 INVALID_ORIGIN` before the password is even checked, which reads
      // like a credentials problem. The native shells depend on
      // `capacitor://localhost` and `https://localhost` being in here, the
      // desktop app on `app://-`.
      console.log(
        `[server] Trusted origins: ${getTrustedOrigins().join(", ") || "(none)"}`,
      );
    });
  } catch (err) {
    if (err instanceof SchemaTooNewError || err instanceof BootRefusedError) {
      console.error(`[server] ${err.message}`);
      process.exit(1);
    }
    console.error("[server] Failed to start:", err);
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] ${signal} received, shutting down gracefully...`);

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // Stop accepting new connections
  server.close();

  // Let a job run in flight finish before its database goes away
  await stopScheduler();

  // Disconnect from databases and auth
  await disconnectAuth();
  await disconnectRedis();
  await disconnectFromDB();

  console.log("[server] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Force exit after 10 seconds
const FORCE_EXIT_MS = 10_000;
process.on("SIGTERM", () => {
  setTimeout(() => {
    console.error("[server] Forced exit after timeout");
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
});

start();
