/**
 * `admin reset-two-factor`, run through `runAdmin` against a real better-auth
 * instance on the in-memory adapter with the two-factor plugin and guard
 * wired as in `auth/auth.ts`.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { symmetricDecrypt } from "better-auth/crypto";
import { bearer } from "better-auth/plugins/bearer";
import { TWO_FACTOR_CHALLENGE_RESPONSE_HEADER } from "@starter/shared";

import { twoFactorPlugin } from "../auth/account-security.js";
import { hotp } from "../auth/second-factor.js";
import { twoFactorGuard, type GuardSession } from "../auth/two-factor-guard.js";
import { parseAdminArgs } from "../cli/args.js";
import type { AdminAuth } from "../cli/accounts.js";
import { runAdmin, type AdminIo, type AdminRuntime } from "../cli/main.js";

type Row = Record<string, unknown> & { id: string };
const SECRET = "two-factor-reset-secret-0123456789-abcdefgh";
const PASSWORD = "correct horse battery";
const BASE = "http://localhost:3000";

let db: Record<"user" | "session" | "account" | "verification" | "twoFactor", Row[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

beforeEach(() => {
  db = { user: [], session: [], account: [], verification: [], twoFactor: [] };
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: SECRET,
    baseURL: BASE,
    logger: { disabled: true },
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password: string) => `plain:${password}`,
        verify: async ({ hash, password }: { hash: string; password: string }) => hash === `plain:${password}`,
      },
    },
    plugins: [
      twoFactorPlugin(),
      bearer(),
      twoFactorGuard({
        frontendUrl: BASE,
        getSession: async (headers) =>
          (await auth.api.getSession({ headers, query: { disableCookieCache: true } })) as GuardSession | null,
      }),
    ],
  });
});

function run(): { io: AdminIo; stdout: () => string } {
  let out = "";
  return {
    io: {
      stdin: new PassThrough(),
      stdout: { write: (chunk: string) => (out += chunk) },
      stderr: { write: () => true },
    },
    stdout: () => out,
  };
}

const runtime = (): AdminRuntime => ({
  withAuth: async (task) => task(auth as AdminAuth),
  doctorInputs: async () => {
    throw new Error("not used");
  },
  withDatabase: async () => {
    throw new Error("not used");
  },
});

async function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** An account with 2FA on, one live session, and a pending challenge. */
async function locked(email: string): Promise<{ id: string }> {
  const up = await call("/sign-up/email", { email, password: PASSWORD, name: "Locked" });
  const token = up.headers.get("set-auth-token")!;
  const id = ((await up.json()) as { user: { id: string } }).user.id;
  await call("/two-factor/enable", { password: PASSWORD }, { authorization: `Bearer ${token}` });
  const row = db.twoFactor.find((candidate) => candidate.userId === id)!;
  const secret = await symmetricDecrypt({ key: SECRET, data: String(row.secret) });
  const verify = await call(
    "/two-factor/verify-totp",
    { code: hotp(secret, Math.floor(Date.now() / 30_000)) },
    { authorization: `Bearer ${token}` },
  );
  assert.equal(verify.status, 200);
  const challenge = await call("/sign-in/email", { email, password: PASSWORD });
  assert.ok(challenge.headers.get(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER));
  return { id };
}

describe("admin reset-two-factor", () => {
  it("parses --email, --commit and --keep-sessions", () => {
    assert.deepEqual(parseAdminArgs(["reset-two-factor", "--email", "a@example.com"]), {
      ok: true,
      command: { kind: "reset-two-factor", email: "a@example.com", commit: false, keepSessions: false },
    });
    assert.deepEqual(parseAdminArgs(["reset-two-factor", "--email=a@example.com", "--commit", "--keep-sessions"]), {
      ok: true,
      command: { kind: "reset-two-factor", email: "a@example.com", commit: true, keepSessions: true },
    });
    assert.equal(parseAdminArgs(["reset-two-factor"]).ok, false);
  });

  it("changes nothing without --commit", async () => {
    const { id } = await locked("dry@example.com");
    const before = JSON.stringify(db);
    const out = run();
    assert.equal(await runAdmin(["reset-two-factor", "--email", "dry@example.com"], out.io, runtime()), 0);
    assert.match(out.stdout(), /^Dry run: would turn two-factor authentication off for dry@example\.com/);
    assert.match(out.stdout(), /sign out 1 session/);
    assert.equal(JSON.stringify(db), before);
    assert.equal(db.user.find((row) => row.id === id)?.twoFactorEnabled, true);
  });

  it("turns 2FA off, clears its rows and sessions, and the password alone signs in", async () => {
    const { id } = await locked("lost@example.com");
    const out = run();
    assert.equal(
      await runAdmin(["reset-two-factor", "--email", "lost@example.com", "--commit"], out.io, runtime()),
      0,
    );
    assert.match(out.stdout(), /Turned two-factor authentication off for lost@example\.com/);
    assert.equal(db.user.find((row) => row.id === id)?.twoFactorEnabled, false);
    assert.equal(db.twoFactor.length, 0);
    assert.equal(db.session.length, 0);
    assert.ok(
      !db.verification.some((row) => row.value === id && String(row.identifier).startsWith("2fa-")),
      "no pending challenge, spent code or marker is left",
    );

    const signIn = await call("/sign-in/email", { email: "lost@example.com", password: PASSWORD });
    assert.equal(signIn.status, 200);
    assert.ok(signIn.headers.get("set-auth-token"));
    assert.equal(signIn.headers.get(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER), null);
  });

  it("keeps sessions with --keep-sessions", async () => {
    await locked("keep@example.com");
    const out = run();
    await runAdmin(["reset-two-factor", "--email", "keep@example.com", "--commit", "--keep-sessions"], out.io, runtime());
    assert.equal(db.session.length, 1);
    assert.match(out.stdout(), /kept every session/);
  });

  it("refuses an unknown email", async () => {
    const out = run();
    assert.equal(await runAdmin(["reset-two-factor", "--email", "nobody@example.com", "--commit"], out.io, runtime()), 1);
  });
});
