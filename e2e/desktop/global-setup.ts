import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

import { API_ORIGIN, API_PORT, APP_ORIGIN, E2E_BINARY_INFO, REPO_ROOT, freshUserDataDir, launchApp, removeWebkitStores } from "./support";

/*
 * Servers and build for the desktop harness, following the E2E isolation
 * convention: an own `mongod` on a random port with a throwaway data
 * directory (or MONGODB_URI when CI provides one), an own production-mode API
 * on a high port, and nothing shared with a developer's running stack.
 * Returns the teardown, which stops only what it started.
 */

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(true));
    server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. The export (embedded into the binary) and the debug build with the e2e
  // control channel. build-desktop.mjs reuses an export built for this API
  // and rebuilds it with DESKTOP_E2E_REBUILD=1; cargo rebuilds only what
  // changed. A renderer change therefore needs DESKTOP_E2E_REBUILD=1.
  console.log(`[desktop-e2e] building the desktop app against ${API_ORIGIN}`);
  const build = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-desktop.mjs"), "--e2e"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_URL: API_ORIGIN },
  });
  if (build.status !== 0) throw new Error("scripts/build-desktop.mjs --e2e failed");
  if (!existsSync(E2E_BINARY_INFO)) throw new Error(`scripts/build-desktop.mjs --e2e wrote no ${E2E_BINARY_INFO}`);

  // One launch and quit before any spec: macOS scans a freshly built,
  // unsigned binary on its first launch, which can take longer than a spec's
  // whole timeout. Headless, with a throwaway profile, like every launch.
  // The WebKit data store each launch creates on macOS (support.ts →
  // webkitStoreDir), removed again when the run ends.
  const storeLogDir = mkdtempSync(join(tmpdir(), "tyt-desktop-e2e-stores-"));
  const storeLog = join(storeLogDir, "stores.txt");
  writeFileSync(storeLog, "");
  process.env.DESKTOP_E2E_STORE_LOG = storeLog;

  const warmProfile = freshUserDataDir();
  try {
    await (await launchApp(warmProfile)).app.close();
  } finally {
    rmSync(warmProfile, { recursive: true, force: true });
  }

  // 2. MongoDB.
  let mongod: ChildProcess | null = null;
  let dbPath: string | null = null;
  let mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    const port = await freePort();
    dbPath = mkdtempSync(join(tmpdir(), "tyt-desktop-e2e-db-"));
    // A single-node replica set: the app sends entry writes durably
    // (entries.applyOperation), and a standalone mongod refuses those with 412.
    mongod = spawn("mongod", ["--port", String(port), "--bind_ip", "127.0.0.1", "--dbpath", dbPath, "--replSet", "desktop-e2e", "--quiet"], {
      stdio: "ignore",
    });
    mongod.on("error", (err) => console.error("[desktop-e2e] mongod failed to start:", err.message));
    mongoUri = `mongodb://127.0.0.1:${port}/trackyourtime-desktop-e2e`;
    await waitFor(() => portInUse(port), `mongod on ${port}`, 30_000);
    const admin = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`);
    try {
      await admin.db("admin").command({
        replSetInitiate: { _id: "desktop-e2e", members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
      });
      await waitFor(
        async () => Boolean((await admin.db("admin").command({ hello: 1 })).isWritablePrimary),
        "replica-set primary",
        30_000,
      );
    } finally {
      await admin.close();
    }
  }

  // 3. The APIs, production-shaped, trusting the app's origin. Every request
  //    they receive is logged (record-requests.mjs), so a spec can prove from
  //    the server side what the app sent — in particular that no Cookie ever
  //    arrived. The second API is another server the app can be pointed at
  //    (the server picker), with its own database.
  if (await portInUse(API_PORT)) {
    throw new Error(`Port ${API_PORT} is taken. Set DESKTOP_E2E_API_PORT to a free port (the export is rebuilt for it).`);
  }
  const logDir = mkdtempSync(join(tmpdir(), "tyt-desktop-e2e-requests-"));
  const requestLog = join(logDir, "api.jsonl");
  const secondRequestLog = join(logDir, "second-api.jsonl");
  writeFileSync(requestLog, "");
  writeFileSync(secondRequestLog, "");
  const secondPort = await freePort();
  const secondOrigin = `http://127.0.0.1:${secondPort}`;
  const secondMongo = new URL(mongoUri);
  secondMongo.pathname = "/trackyourtime-desktop-e2e-second";
  const secondMongoUri = secondMongo.toString();

  const startApi = (port: number, origin: string, database: string, log: string): ChildProcess =>
    spawn(process.execPath, ["--import", "tsx", "--import", join(__dirname, "record-requests.mjs"), "src/index.ts"], {
      cwd: join(REPO_ROOT, "packages/server"),
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        MONGODB_URI: database,
        REDIS_URL: "",
        BETTER_AUTH_SECRET: "desktop-e2e-secret-desktop-e2e-secret",
        BETTER_AUTH_URL: origin,
        FRONTEND_URL: "http://127.0.0.1:1",
        TRUSTED_ORIGINS: APP_ORIGIN,
        SCHEDULER_ENABLED: "false",
        DESKTOP_E2E_REQUEST_LOG: log,
        E2E_DISABLE_AUTH_RATE_LIMIT: "1",
      },
    });
  const api = startApi(API_PORT, API_ORIGIN, mongoUri, requestLog);
  const secondApi = startApi(secondPort, secondOrigin, secondMongoUri, secondRequestLog);
  await waitFor(
    async () => (await fetch(`${API_ORIGIN}/api/health`)).ok,
    `the API on ${API_ORIGIN}`,
    60_000,
  );
  await waitFor(
    async () => (await fetch(`${secondOrigin}/api/health`)).ok,
    `the second API on ${secondOrigin}`,
    60_000,
  );

  // Read by the specs (support.ts); workers inherit this process's env.
  process.env.DESKTOP_E2E_REQUEST_LOG = requestLog;
  process.env.DESKTOP_E2E_SECOND_API = secondOrigin;
  process.env.DESKTOP_E2E_SECOND_REQUEST_LOG = secondRequestLog;
  process.env.DESKTOP_E2E_MONGODB_URI = mongoUri;

  return async () => {
    await stop(api);
    await stop(secondApi);
    await stop(mongod);
    if (dbPath) rmSync(dbPath, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    removeWebkitStores(storeLog);
    rmSync(storeLogDir, { recursive: true, force: true });
  };
}
