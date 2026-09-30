import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
export async function startQAAPI(
  root,
  output,
  appOrigin = "capacitor://localhost",
) {
  const children = [];
  writeFileSync(join(output, "requests.jsonl"), "");
  const db = mkdtempSync(join(tmpdir(), "trackyourtime-native-qa-db-"));
  const stop = async () => {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || !child.pid) continue;
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    rmSync(db, { recursive: true, force: true });
  };
  const start = (bin, args, options, log) => {
    const fd = openSync(join(output, log), "a");
    const child = spawn(bin, args, { ...options, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    child.on("error", (error) => {
      child.qaError = error;
    });
    children.push(child);
    return child;
  };
  try {
    const dbPort = await port();
    const apiPort = await port();
    const origin = `http://127.0.0.1:${apiPort}`;
    start(
      "mongod",
      [
        "--port",
        String(dbPort),
        "--bind_ip",
        "127.0.0.1",
        "--dbpath",
        db,
        "--wiredTigerCacheSizeGB",
        "0.25",
        "--quiet",
      ],
      {},
      "mongo.log",
    );
    start(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(root, "e2e/desktop/record-requests.mjs"),
        "src/index.ts",
      ],
      {
        cwd: join(root, "packages/server"),
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(apiPort),
          MONGODB_URI: `mongodb://127.0.0.1:${dbPort}/simulator-qa`,
          REDIS_URL: "",
          SMTP_HOST: "",
          LISTMONK_URL: "",
          STRIPE_SECRET_KEY: "",
          BETTER_AUTH_SECRET: "simulator-qa-only-not-a-real-secret",
          BETTER_AUTH_URL: origin,
          FRONTEND_URL: origin,
          TRUSTED_ORIGINS: appOrigin,
          SCHEDULER_ENABLED: "false",
          DESKTOP_E2E_REQUEST_LOG: join(output, "requests.jsonl"),
        },
      },
      "api.log",
    );
    let ready = false;
    for (let n = 0; n < 120; n++) {
      const dead = children.find(
        (child) => child.qaError || child.exitCode !== null,
      );
      if (dead)
        throw (
          dead.qaError ?? new Error("QA server exited; see api.log/mongo.log")
        );
      try {
        ready = (
          await fetch(`${origin}/api/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready, "QA API did not start");
    const account = {
      email: "simulator-qa@example.com",
      password: "simulator-qa-password-1",
      name: "Simulator QA",
    };
    const headers = {
      "content-type": "application/json",
      origin: appOrigin,
      "user-agent": "desktop-e2e-harness",
    };
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(account),
    });
    assert.equal(
      signup.status,
      200,
      `Fixture account creation failed: ${signup.status}`,
    );
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(account),
    });
    const token = login.headers.get("set-auth-token");
    assert(token, "Fixture sign-in did not return a bearer token");
    const trpc = async (path, input = {}, mutation = false) => {
      const response = await fetch(
        `${origin}/api/trpc/${path}${mutation ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        {
          method: mutation ? "POST" : "GET",
          headers: { ...headers, authorization: `Bearer ${token}` },
          body: mutation ? JSON.stringify(input) : undefined,
        },
      );
      assert(response.ok, `${path} failed: ${response.status}`);
      const json = await response.json();
      return json.result.data?.json ?? json.result.data;
    };
    return { origin, account, trpc, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
