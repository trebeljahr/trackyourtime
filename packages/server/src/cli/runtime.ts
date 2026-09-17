/**
 * The admin CLI's connection to the running instance's configuration and
 * databases: the only file under `cli/` that reads the environment.
 *
 * Everything is imported lazily, so `admin help` and a usage error work on a
 * machine with no configuration at all, and a configuration that
 * `config/env.ts` refuses to load (production with no BETTER_AUTH_SECRET)
 * reaches the operator as one sentence rather than a stack trace from an
 * import.
 */
import { CliError } from "./errors.js";
import type { AdminAuth } from "./accounts.js";
import type { Db } from "mongodb";
import type { DoctorInputs } from "./doctor.js";

/** How long a connection attempt may take before the command gives up. */
const CONNECT_TIMEOUT_MS = 5_000;

async function loadEnv(): Promise<typeof import("../config/env.js")> {
  try {
    return await import("../config/env.js");
  } catch (error) {
    throw new CliError(
      `the server configuration did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Connect the way the server does — mongoose for the app's own collections,
 * better-auth on its own client — run `task`, and disconnect whatever
 * happened.
 */
export async function withAuth<T>(task: (auth: AdminAuth) => Promise<T>): Promise<T> {
  const { env } = await loadEnv();
  const mongoose = (await import("mongoose")).default;
  const { initAuth, getAuth, disconnectAuth } = await import("../auth/auth.js");

  try {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      });
      await initAuth();
    } catch (error) {
      throw new CliError(
        `could not connect to MongoDB: ${error instanceof Error ? error.message : String(error)}. ` +
          "Run the doctor command for details.",
      );
    }
    return await task(getAuth() as AdminAuth);
  } finally {
    await disconnectAuth().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
  }
}

/**
 * The app database on a plain driver client — the migration runner and the
 * index inspection need nothing from mongoose or better-auth.
 */
export async function withDatabase<T>(task: (db: Db, release: string) => Promise<T>): Promise<T> {
  const { env } = await loadEnv();
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  try {
    try {
      await client.connect();
    } catch (error) {
      throw new CliError(
        `could not connect to MongoDB: ${error instanceof Error ? error.message : String(error)}. ` +
          "Run the doctor command for details.",
      );
    }
    return await task(client.db(), env.RELEASE);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The doctor's inputs, bound to this process's environment. */
export async function doctorInputsFromEnv(): Promise<DoctorInputs> {
  const { env, getTrustedOrigins } = await loadEnv();
  const email = await import("../services/email.js");

  const { API_LEVEL } = await import("@starter/shared");
  const { SCHEMA_VERSION } = await import("../services/migrations/index.js");

  return {
    version: {
      release: env.RELEASE,
      apiLevel: API_LEVEL,
      schemaVersion: SCHEMA_VERSION,
      updateCheck: env.TRACKYOURTIME_UPDATE_CHECK,
    },
    releaseCheck: () =>
      withDatabase(async (db) => {
        const { readReleaseCheck } = await import("../services/update-check.js");
        return readReleaseCheck(db);
      }),
    urls: {
      appUrl: env.APP_URL,
      frontendUrl: env.FRONTEND_URL,
      betterAuthUrl: env.BETTER_AUTH_URL,
      trustedOrigins: getTrustedOrigins(),
      isProduction: env.isProduction,
    },
    mail: {
      configured: email.isEmailDeliveryConfigured(),
      transport: email.selectEmailTransport(env),
      fromAddress: email.resolveFromAddress(env),
    },
    redisUrl: env.REDIS_URL,
    mongo: () => pingMongo(env.MONGODB_URI),
    redisPing: pingRedis,
    schema: () =>
      withDatabase(async (db) => {
        const { MIGRATIONS, SCHEMA_VERSION, migrationStatus } = await import(
          "../services/migrations/index.js"
        );
        return migrationStatus(db, MIGRATIONS, SCHEMA_VERSION);
      }),
    indexes: () =>
      withDatabase(async (db) => {
        const { allModels } = await import("../models/registry.js");
        const { inspectModelIndexes } = await import("../db/indexes.js");
        return inspectModelIndexes(db, allModels());
      }),
  };
}

async function pingMongo(uri: string): Promise<{ serverTime: Date | null }> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const admin = client.db().admin();
    await admin.command({ ping: 1 });
    const hello = await admin.command({ hello: 1 });
    const localTime: unknown = hello.localTime;
    return { serverTime: localTime instanceof Date ? localTime : null };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function pingRedis(url: string): Promise<void> {
  const { Redis } = await import("ioredis");
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // ioredis reports the cause of a failed connection only as an event — the
  // rejection itself says "Connection is closed." — and with no listener it
  // prints every event to stderr on top of the doctor's verdict.
  let cause: Error | null = null;
  redis.on("error", (error: Error) => {
    cause = error;
  });
  try {
    await redis.connect().catch((error: unknown) => {
      throw cause ?? error;
    });
    const answer = await redis.ping();
    if (answer !== "PONG") throw new Error(`unexpected answer ${JSON.stringify(answer)}`);
  } finally {
    redis.disconnect();
  }
}
