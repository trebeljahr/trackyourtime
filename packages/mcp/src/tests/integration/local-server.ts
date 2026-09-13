// A real Track Your Time API for the integration tests: its own MongoDB, its
// own port, its own account and tokens.
//
// Isolation is the point, per the repo's E2E convention. A shared database or
// a default port means another worktree's server answers the requests and the
// test passes against code that is not this checkout's. So `mongod` is started
// here on a random port with a throwaway data directory, unless MONGODB_URI
// names a disposable database explicitly.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../../..");
const SERVER_DIR = join(REPO_ROOT, "packages/server");

export type LocalServer = {
  apiUrl: string;
  signUp: (email: string) => Promise<string>;
  mintToken: (cookie: string, scopes: string[]) => Promise<string>;
  stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  child: ChildProcess,
  output: () => string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited with code ${child.exitCode} before it was ready:\n${output()}`);
    }
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} was not ready after ${timeoutMs}ms:\n${output()}`);
}

function capture(child: ChildProcess): () => string {
  let log = "";
  const append = (chunk: Buffer): void => {
    log = (log + chunk.toString()).slice(-8_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => log;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

/** Whether this machine can host the suite, and why not when it cannot. */
export function canRunLocalServer(): { ok: true } | { ok: false; reason: string } {
  if (process.env.MONGODB_URI) return { ok: true };
  const probe = spawnSync("mongod", ["--version"], { stdio: "ignore" });
  return probe.status === 0
    ? { ok: true }
    : { ok: false, reason: "no mongod on PATH and no MONGODB_URI set" };
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      ok(true);
    });
    socket.once("error", () => ok(false));
  });
}

export async function startLocalServer(): Promise<LocalServer> {
  let mongod: ChildProcess | null = null;
  let dataDir: string | null = null;
  let mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    const mongoPort = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), "trackyourtime-mcp-mongo-"));
    mongod = spawn(
      "mongod",
      ["--dbpath", dataDir, "--port", String(mongoPort), "--bind_ip", "127.0.0.1", "--quiet"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const mongoLog = capture(mongod);
    await waitFor(() => portAccepts(mongoPort), "mongod", mongod, mongoLog);
    mongoUri = `mongodb://127.0.0.1:${mongoPort}/trackyourtime-mcp-test`;
  }

  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      MONGODB_URI: mongoUri,
      // Set, and empty, so a developer's .env.development cannot point the
      // test server at a Redis nobody started for it.
      REDIS_URL: "",
      BETTER_AUTH_SECRET: "trackyourtime-mcp-integration-secret",
      BETTER_AUTH_URL: apiUrl,
      FRONTEND_URL: apiUrl,
      APP_URL: "",
      SENTRY_DSN: "",
    },
  });
  const serverLog = capture(server);

  const stop = async (): Promise<void> => {
    await stopChild(server);
    await stopChild(mongod);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    await waitFor(
      async () => (await fetch(`${apiUrl}/api/health`)).ok,
      "the API server",
      server,
      serverLog,
    );
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    apiUrl,
    async signUp(email) {
      const response = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "MCP Test", email, password: "correct-horse-battery" }),
      });
      if (!response.ok) {
        throw new Error(`sign-up answered ${response.status}: ${await response.text()}`);
      }
      const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
      return cookies.join("; ");
    },
    async mintToken(cookie, scopes) {
      const response = await fetch(`${apiUrl}/api/trpc/apiTokens.create`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: `mcp ${scopes.join(" ")}`, scopes }),
      });
      const body = (await response.json()) as { result?: { data?: { plaintext?: string } } };
      const plaintext = body.result?.data?.plaintext;
      if (!response.ok || !plaintext) {
        throw new Error(`apiTokens.create answered ${response.status}: ${JSON.stringify(body)}`);
      }
      return plaintext;
    },
    stop,
  };
}
