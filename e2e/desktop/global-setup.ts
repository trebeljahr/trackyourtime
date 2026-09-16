import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API_ORIGIN, API_PORT, EXPORT_DIR, MAIN_JS, REPO_ROOT } from "./support";

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
  // 1. The Electron binary (Electron 42 downloads it lazily; see the script).
  const ensure = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/ensure-electron.mjs")], {
    stdio: "inherit",
  });
  if (ensure.status !== 0) throw new Error("scripts/ensure-electron.mjs failed");

  // 2. The export, built against this harness's API — reused when it already is.
  const target = join(EXPORT_DIR, ".build-target.json");
  const builtFor = existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as { apiUrl?: string }).apiUrl : null;
  if (builtFor !== API_ORIGIN || !existsSync(MAIN_JS) || process.env.DESKTOP_E2E_REBUILD === "1") {
    console.log(`[desktop-e2e] building the desktop export against ${API_ORIGIN}`);
    const build = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-desktop.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, NEXT_PUBLIC_API_URL: API_ORIGIN },
    });
    if (build.status !== 0) throw new Error("scripts/build-desktop.mjs failed");
  } else {
    // The export is reused, but main and preload are always re-bundled: they
    // take a second, and a reused electron/dist runs every spec against the
    // main process as it was before the change under test.
    const bundle = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/build-desktop.mjs"), "--electron-only"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (bundle.status !== 0) throw new Error("scripts/build-desktop.mjs --electron-only failed");
  }

  // 3. MongoDB.
  let mongod: ChildProcess | null = null;
  let dbPath: string | null = null;
  let mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    const port = await freePort();
    dbPath = mkdtempSync(join(tmpdir(), "tyt-desktop-e2e-db-"));
    mongod = spawn("mongod", ["--port", String(port), "--bind_ip", "127.0.0.1", "--dbpath", dbPath, "--quiet"], {
      stdio: "ignore",
    });
    mongod.on("error", (err) => console.error("[desktop-e2e] mongod failed to start:", err.message));
    mongoUri = `mongodb://127.0.0.1:${port}/trackyourtime-desktop-e2e`;
    await waitFor(() => portInUse(port), `mongod on ${port}`, 30_000);
  }

  // 4. The API, production-shaped, trusting the app's origin.
  if (await portInUse(API_PORT)) {
    throw new Error(`Port ${API_PORT} is taken. Set DESKTOP_E2E_API_PORT to a free port (the export is rebuilt for it).`);
  }
  const api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(REPO_ROOT, "packages/server"),
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(API_PORT),
      MONGODB_URI: mongoUri,
      REDIS_URL: "",
      BETTER_AUTH_SECRET: "desktop-e2e-secret-desktop-e2e-secret",
      BETTER_AUTH_URL: API_ORIGIN,
      FRONTEND_URL: "http://127.0.0.1:1",
      TRUSTED_ORIGINS: "app://-",
      SCHEDULER_ENABLED: "false",
    },
  });
  await waitFor(
    async () => (await fetch(`${API_ORIGIN}/api/health`)).ok,
    `the API on ${API_ORIGIN}`,
    60_000,
  );

  return async () => {
    await stop(api);
    await stop(mongod);
    if (dbPath) rmSync(dbPath, { recursive: true, force: true });
  };
}
