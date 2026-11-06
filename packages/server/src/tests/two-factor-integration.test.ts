/**
 * Two-factor sign-in and the account controls built on it, against the real
 * better-auth on its in-memory adapter.
 *
 * The instance carries the pieces `auth/auth.ts` registers, in the same order
 * — `twoFactorPlugin()`, `bearer()`, `twoFactorGuard()` — with the cookie
 * cache on as in production, and the session-creation allowlist in
 * `session.create.before`. The "wiring" suite reads `auth.ts` to pin that the
 * real file still matches.
 *
 * Requests go through `auth.handler` with real `Request`s: most of what is
 * under test is what goes over the wire — which headers and cookies a
 * response carries, and what a client holding them can do.
 *
 * Some suites pin better-auth behaviour the guard relies on rather than
 * repeats (challenge expiry, replay, per-challenge and per-account limits).
 * They are tripwires for the next upgrade.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { symmetricDecrypt } from "better-auth/crypto";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import {
  TWO_FACTOR_ALREADY_ENABLED,
  TWO_FACTOR_CHALLENGE_REQUEST_HEADER,
  TWO_FACTOR_CHALLENGE_RESPONSE_HEADER,
  TWO_FACTOR_CODE_INVALID,
  TWO_FACTOR_CODE_REQUIRED,
  TWO_FACTOR_MAX_STEP_UP_ATTEMPTS,
  TWO_FACTOR_OPTION_NOT_ALLOWED,
  TWO_FACTOR_STEP_UP_REQUIRED,
  TWO_FACTOR_TOO_MANY_ATTEMPTS,
} from "@starter/shared";

import {
  emailVerificationOptions,
  resolveAuthConfig,
  sweepSocketsAfterRevocation,
  twoFactorPlugin,
  TWO_FACTOR_ISSUER,
} from "../auth/account-security.js";
import { loginSessionPlugin } from "../auth/login-session.js";
import {
  hasLiveStepUp,
  hotp,
  readAttempts,
  spentTotpStepIdentifier,
  stepUpAttemptsIdentifier,
  type SecondFactorAdapter,
} from "../auth/second-factor.js";
import {
  sessionCreationAllowed,
  TWO_FACTOR_SESSION_PATHS,
  twoFactorGuard,
  type GuardSession,
} from "../auth/two-factor-guard.js";
import { backfillEmailVerified } from "../scripts/backfill-email-verified.js";
import { assertTwoFactorStepUp } from "../trpc/routers/api-tokens.js";

type Row = Record<string, unknown> & { id: string };
type MemoryDb = Record<"user" | "session" | "account" | "verification" | "twoFactor" | "deviceCode", Row[]>;

const BASE = "http://localhost:3000";
const SECRET = "two-factor-integration-secret-0123456789-abcdef";
const PASSWORD = "correct horse battery";
const GOOGLE_CLIENT_ID = "google-client-id";

let db: MemoryDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
let sweeps = 0;
let sent: { url: string; to: string }[] = [];
let resetTokens: string[] = [];
let seq = 0;

function build(): void {
  db = { user: [], session: [], account: [], verification: [], twoFactor: [], deviceCode: [] };
  sent = [];
  resetTokens = [];
  sweeps = 0;
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: SECRET,
    baseURL: BASE,
    trustedOrigins: [BASE],
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ token }: { token: string }) => {
        resetTokens.push(token);
      },
      // scrypt costs far more per call than anything tested here.
      password: {
        hash: async (password: string) => `plain:${password}`,
        verify: async ({ hash, password }: { hash: string; password: string }) => hash === `plain:${password}`,
      },
    },
    emailVerification: emailVerificationOptions(async (url, mail) => {
      sent.push({ url, to: mail.to });
    }),
    user: { changeEmail: { enabled: true }, deleteUser: { enabled: true } },
    socialProviders: { google: { clientId: GOOGLE_CLIENT_ID, clientSecret: "google-client-secret" } },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    hooks: { after: sweepSocketsAfterRevocation(() => (sweeps += 1)) },
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }, context: unknown) =>
            (await sessionCreationAllowed(session.userId, context as never)) ? undefined : false,
        },
      },
    },
    // Same order as auth/auth.ts — the order is the point.
    plugins: [
      twoFactorPlugin(),
      bearer(),
      twoFactorGuard({
        getSession: async (headers) =>
          (await auth.api.getSession({ headers, query: { disableCookieCache: true } })) as GuardSession | null,
      }),
      loginSessionPlugin(),
      deviceAuthorization({ expiresIn: "10m", interval: "5s" }),
    ],
  });
}

beforeEach(build);

// --- helpers ------------------------------------------------------------------

type Reply = { status: number; json: Record<string, unknown> | null; headers: Headers };

async function call(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: "GET" | "POST" } = {},
): Promise<Reply> {
  const method = init.method ?? "POST";
  const response: Response = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers: {
        origin: BASE,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
    }),
  );
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers };
}

const bearerHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const code = (reply: Reply): unknown => reply.json?.code;

/** The cookies a browser would hold after `headers`: last value per name, empty ones dropped. */
function jar(headers: Headers, previous = ""): string {
  const cookies = new Map<string, string>();
  for (const pair of previous.split("; ").filter(Boolean)) {
    const eq = pair.indexOf("=");
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...cookies].filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join("; ");
}

/** The first value each cookie name was set to, the way a careless script keeps them. */
function firstSeenCookies(headers: Headers): string {
  const seen = new Map<string, string>();
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (!seen.has(pair.slice(0, eq))) seen.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...seen].map(([name, value]) => `${name}=${value}`).join("; ");
}

type Person = { id: string; email: string; token: string };

async function signUp(): Promise<Person> {
  seq += 1;
  const email = `person-${seq}@example.com`;
  const reply = await call("/sign-up/email", { body: { email, password: PASSWORD, name: `Person ${seq}` } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  const token = reply.headers.get("set-auth-token");
  assert.ok(token);
  return { id: String((reply.json?.user as { id: string }).id), email, token };
}

async function secretFor(userId: string): Promise<string> {
  const row = db.twoFactor.find((candidate) => candidate.userId === userId);
  assert.ok(row, "no twoFactor row");
  return symmetricDecrypt({ key: SECRET, data: String(row.secret) });
}

const currentStep = (): number => Math.floor(Date.now() / 30_000);

/**
 * A code for a time step this user has not spent yet. A code verifies once,
 * and the ±1-step window offers three steps at any moment: the next (valid
 * longest), the current, then the previous.
 */
async function totpFor(userId: string): Promise<string> {
  const secret = await secretFor(userId);
  const now = currentStep();
  for (const step of [now + 1, now, now - 1]) {
    if (!db.verification.some((row) => row.identifier === spentTotpStepIdentifier(userId, step))) {
      return hotp(secret, step);
    }
  }
  throw new Error("every step in the window is spent: this test verifies too many codes");
}

/** A six-digit code the window does not accept right now. */
async function wrongTotpFor(userId: string): Promise<string> {
  const secret = await secretFor(userId);
  const now = currentStep();
  const valid = new Set([now - 1, now, now + 1].map((step) => hotp(secret, step)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}

type Enrolled = Person & { backupCodes: string[]; uri: string };

/** Enable and verify over bearer; returns the rotated token. */
async function enrol(person: Person): Promise<Enrolled> {
  const enabled = await call("/two-factor/enable", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  const verified = await call("/two-factor/verify-totp", {
    body: { code: await totpFor(person.id) },
    headers: bearerHeaders(person.token),
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  const token = verified.headers.get("set-auth-token");
  assert.ok(token, "enrolment verify rotates the session");
  return {
    ...person,
    token,
    backupCodes: enabled.json?.backupCodes as string[],
    uri: String(enabled.json?.totpURI),
  };
}

const signIn = (email: string, headers: Record<string, string> = {}): Promise<Reply> =>
  call("/sign-in/email", { body: { email, password: PASSWORD }, headers });

/** A 2FA sign-in, and the challenge it hands a client without a cookie jar. */
async function challenge(person: { email: string }): Promise<{ value: string; reply: Reply }> {
  const reply = await signIn(person.email);
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.equal(reply.json?.twoFactorRedirect, true);
  const value = reply.headers.get(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER);
  assert.ok(value, "a 2FA sign-in carries the challenge header");
  return { value, reply };
}

const verifyWithHeader = (
  value: string,
  totpOrBackup: string,
  extra: { path?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<Reply> =>
  call(extra.path ?? "/two-factor/verify-totp", {
    body: { code: totpOrBackup, ...extra.body },
    headers: { [TWO_FACTOR_CHALLENGE_REQUEST_HEADER]: value, ...extra.headers },
  });

const sessionFor = (headers: Record<string, string>): Promise<GuardSession | null> =>
  auth.api.getSession({ headers: new Headers(headers), query: { disableCookieCache: true } });

const userRow = (id: string): Row => db.user.find((row) => row.id === id) as Row;

const adapter = async (): Promise<SecondFactorAdapter> => (await auth.$context).adapter;

/** A full web sign-in through the challenge cookie; returns the browser's jar. */
async function browserSignIn(person: Enrolled): Promise<string> {
  const first = await signIn(person.email);
  const cookies = jar(first.headers);
  const verified = await call("/two-factor/verify-totp", {
    body: { code: await totpFor(person.id) },
    headers: { cookie: cookies },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  return jar(verified.headers, cookies);
}

// --- tests ----------------------------------------------------------------------

describe("auth/auth.ts wiring", () => {
  const source = readFileSync(new URL("../auth/auth.ts", import.meta.url), "utf8");

  it("registers twoFactor, then bearer, then the guard", () => {
    // Every other order still type-checks and still passes a test that builds
    // its own instance; so the real file is read.
    const twoFactorAt = source.indexOf("twoFactorPlugin(),");
    const bearerAt = source.indexOf("bearer(),");
    const guardAt = source.indexOf("twoFactorGuard(");
    assert.ok(twoFactorAt > 0 && bearerAt > 0 && guardAt > 0, "all three are registered");
    assert.ok(twoFactorAt < bearerAt, "twoFactorPlugin() before bearer()");
    assert.ok(bearerAt < guardAt, "bearer() before twoFactorGuard()");
  });

  it("signs every device out on a password reset", () => {
    assert.match(source, /revokeSessionsOnPasswordReset: true/);
  });

  it("applies the session-creation allowlist", () => {
    assert.match(source, /sessionCreationAllowed\(session\.userId, context/);
  });

  it("lists exactly the reviewed session-creating paths", () => {
    // A new entry must be a deliberate edit here too: each one is a way for
    // an account with 2FA on to get a session.
    assert.deepEqual([...TWO_FACTOR_SESSION_PATHS].sort(), [
      "/change-password",
      "/device/token",
      "/passkey/verify-authentication",
      "/sign-in/email",
      "/two-factor/disable",
      "/two-factor/verify-backup-code",
      "/two-factor/verify-totp",
    ]);
  });
});

describe("enrolment", () => {
  it("does not switch 2FA on until a code from the authenticator verifies", async () => {
    const person = await signUp();
    const enabled = await call("/two-factor/enable", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    assert.match(String(enabled.json?.totpURI), /^otpauth:\/\/totp\//);
    assert.ok(String(enabled.json?.totpURI).includes(encodeURIComponent(TWO_FACTOR_ISSUER)));
    assert.equal((enabled.json?.backupCodes as string[]).length, 10);
    assert.notEqual(userRow(person.id).twoFactorEnabled, true);

    // A password alone still signs in: the QR code was never confirmed.
    const unconfirmed = await signIn(person.email);
    assert.ok(unconfirmed.headers.get("set-auth-token"));

    const verified = await call("/two-factor/verify-totp", {
      body: { code: await totpFor(person.id) },
      headers: bearerHeaders(person.token),
    });
    assert.equal(verified.status, 200);
    assert.equal(userRow(person.id).twoFactorEnabled, true);
  });

  it("refuses to enable again over a live secret, and never hands out the URI", async () => {
    const person = await enrol(await signUp());
    const before = db.twoFactor.find((row) => row.userId === person.id)?.secret;

    const again = await call("/two-factor/enable", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    assert.equal(again.status, 400);
    assert.equal(code(again), TWO_FACTOR_ALREADY_ENABLED);
    assert.equal(db.twoFactor.find((row) => row.userId === person.id)?.secret, before, "the secret is unchanged");

    for (const path of ["/two-factor/get-totp-uri", "/two-factor/send-otp", "/two-factor/verify-otp"]) {
      const reply = await call(path, { body: { password: PASSWORD, code: "123456" }, headers: bearerHeaders(person.token) });
      assert.equal(reply.status, 404, path);
    }
  });

  it("lets enable run again before the first verify, replacing the pending secret", async () => {
    const person = await signUp();
    await call("/two-factor/enable", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    const first = await secretFor(person.id);
    const again = await call("/two-factor/enable", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    assert.equal(again.status, 200);
    assert.notEqual(await secretFor(person.id), first);
  });
});

describe("the sign-in challenge", () => {
  it("answers with a challenge header and no session of any kind", async () => {
    const person = await enrol(await signUp());
    const sessionsBefore = db.session.length;
    const { value, reply } = await challenge(person);

    assert.deepEqual(reply.json, { twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    assert.equal(reply.headers.get("set-auth-token"), null);
    assert.equal(db.session.length, sessionsBefore, "the password session is deleted again");
    assert.ok(value.startsWith("2fa-"), value);
    const exposed = String(reply.headers.get("access-control-expose-headers"));
    assert.ok(exposed.includes(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER), exposed);
    // better-auth <1.6.33 sent the live session cookies first and their
    // expiry after; a script keeping the first value of each held a session
    // out of the cookie cache. Pinned, because nothing here removes them.
    assert.equal(await sessionFor({ cookie: firstSeenCookies(reply.headers) }), null);
    assert.equal(
      await auth.api.getSession({ headers: new Headers({ cookie: firstSeenCookies(reply.headers) }) }),
      null,
      "not out of the cookie cache either",
    );
  });

  it("completes through the header, with no cookie, and only then issues a token", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    // A phone holding a stale token from an earlier session sends it along.
    const verified = await verifyWithHeader(value, await totpFor(person.id), {
      headers: { authorization: "Bearer garbage.value" },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    const token = verified.headers.get("set-auth-token");
    assert.ok(token);
    assert.equal((await sessionFor(bearerHeaders(token)))?.user.id, person.id);
  });

  it("still completes through the cookie, the way the web app does", async () => {
    const person = await enrol(await signUp());
    const cookies = await browserSignIn(person);
    assert.equal((await sessionFor({ cookie: cookies }))?.user.id, person.id);
  });

  it("refuses a forged header, and a verify with no challenge at all", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    const forged = await verifyWithHeader(`${value.split(".")[0]}.AAAA`, await totpFor(person.id));
    assert.equal(forged.status, 401);
    assert.equal(code(forged), "INVALID_TWO_FACTOR_COOKIE");
    const none = await call("/two-factor/verify-totp", { body: { code: await totpFor(person.id) } });
    assert.equal(none.status, 401);
  });

  it("accepts a backup code exactly once", async () => {
    const person = await enrol(await signUp());
    const [backup] = person.backupCodes;
    const first = await verifyWithHeader((await challenge(person)).value, backup!, { path: "/two-factor/verify-backup-code" });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.ok(first.headers.get("set-auth-token"));
    const second = await verifyWithHeader((await challenge(person)).value, backup!, { path: "/two-factor/verify-backup-code" });
    assert.equal(second.status, 401);
    assert.equal(code(second), "INVALID_BACKUP_CODE");
  });

  it("refuses disableSession and never trusts a device", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    const refused = await verifyWithHeader(value, person.backupCodes[0]!, {
      path: "/two-factor/verify-backup-code",
      body: { disableSession: true },
    });
    assert.equal(refused.status, 400);
    assert.equal(code(refused), TWO_FACTOR_OPTION_NOT_ALLOWED);

    const trusted = await verifyWithHeader(value, await totpFor(person.id), { body: { trustDevice: true } });
    assert.equal(trusted.status, 200, JSON.stringify(trusted.json));
    assert.ok(!jar(trusted.headers).includes("trust_device"), "no trust cookie");
    assert.ok(!db.verification.some((row) => String(row.identifier).startsWith("trust-device-")));
  });
});

describe("what better-auth enforces on a challenge (tripwires)", () => {
  it("refuses an expired challenge even though its row still exists", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    const identifier = value.split(".")[0];
    const row = db.verification.find((candidate) => candidate.identifier === identifier);
    assert.ok(row);
    row.expiresAt = new Date(Date.now() - 1000);
    const reply = await verifyWithHeader(value, await totpFor(person.id));
    assert.equal(reply.status, 401);
  });

  it("refuses a replayed challenge", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    assert.equal((await verifyWithHeader(value, await totpFor(person.id))).status, 200);
    assert.equal((await verifyWithHeader(value, await totpFor(person.id))).status, 401);
  });

  it("allows five wrong codes per challenge, then drops it", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await verifyWithHeader(value, await wrongTotpFor(person.id))).status, 401);
    }
    const sixth = await verifyWithHeader(value, await totpFor(person.id));
    assert.notEqual(sixth.status, 200);
  });

  it("locks the account's challenges after ten wrong codes, whatever the number of challenges", async () => {
    const person = await enrol(await signUp());
    for (let round = 0; round < 3; round += 1) {
      const { value } = await challenge(person);
      for (let attempt = 0; attempt < 4; attempt += 1) await verifyWithHeader(value, await wrongTotpFor(person.id));
    }
    const locked = await verifyWithHeader((await challenge(person)).value, await totpFor(person.id));
    assert.equal(locked.status, 429);
  });
});

describe("a TOTP code verifies once", () => {
  it("is refused for a second sign-in, and for disable, after a sign-in used it", async () => {
    const person = await enrol(await signUp());
    const once = await totpFor(person.id);
    assert.equal((await verifyWithHeader((await challenge(person)).value, once)).status, 200);

    const replay = await verifyWithHeader((await challenge(person)).value, once);
    assert.equal(replay.status, 401);
    assert.equal(code(replay), "INVALID_CODE", "a replay reads exactly like a wrong code");

    const disable = await call("/two-factor/disable", {
      body: { password: PASSWORD, code: once },
      headers: bearerHeaders(person.token),
    });
    assert.equal(code(disable), TWO_FACTOR_CODE_INVALID);
    assert.equal(userRow(person.id).twoFactorEnabled, true);
  });

  it("is refused inside a session once spent", async () => {
    const person = await enrol(await signUp());
    const once = await totpFor(person.id);
    const first = await call("/two-factor/verify-totp", { body: { code: once }, headers: bearerHeaders(person.token) });
    assert.equal(first.status, 200);
    const again = await call("/two-factor/verify-totp", { body: { code: once }, headers: bearerHeaders(person.token) });
    assert.equal(again.status, 401);
  });

  it("lets only one of two parallel sign-ins with the same code through", async () => {
    const person = await enrol(await signUp());
    const once = await totpFor(person.id);
    const [a, b] = await Promise.all([challenge(person), challenge(person)]);
    const replies = await Promise.all([verifyWithHeader(a.value, once), verifyWithHeader(b.value, once)]);
    assert.ok(replies.filter((reply) => reply.status === 200).length <= 1, replies.map((r) => r.status).join(","));
  });
});

describe("disable and regenerate need the password and a code", () => {
  it("checks the password before the code, and the code before anything changes", async () => {
    const person = await enrol(await signUp());
    const headers = bearerHeaders(person.token);

    const wrongPassword = await call("/two-factor/disable", { body: { password: "nope", code: await wrongTotpFor(person.id) }, headers });
    assert.equal(code(wrongPassword), "INVALID_PASSWORD");
    assert.equal(await readAttempts(await adapter(), stepUpAttemptsIdentifier(person.id)), 0, "no code attempt spent");

    const noCode = await call("/two-factor/disable", { body: { password: PASSWORD }, headers });
    assert.equal(code(noCode), TWO_FACTOR_CODE_REQUIRED);
    const wrongCode = await call("/two-factor/disable", { body: { password: PASSWORD, code: await wrongTotpFor(person.id) }, headers });
    assert.equal(code(wrongCode), TWO_FACTOR_CODE_INVALID);
    assert.equal(userRow(person.id).twoFactorEnabled, true);

    const done = await call("/two-factor/disable", { body: { password: PASSWORD, code: await totpFor(person.id) }, headers });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(userRow(person.id).twoFactorEnabled, false);
    const plain = await signIn(person.email);
    assert.ok(plain.headers.get("set-auth-token"), "a password alone signs in again");
  });

  it("locks wrong authenticator codes after ten, and a backup code still disables", async () => {
    const person = await enrol(await signUp());
    const headers = bearerHeaders(person.token);
    for (let attempt = 0; attempt < TWO_FACTOR_MAX_STEP_UP_ATTEMPTS; attempt += 1) {
      const reply = await call("/two-factor/disable", { body: { password: PASSWORD, code: await wrongTotpFor(person.id) }, headers });
      assert.equal(code(reply), TWO_FACTOR_CODE_INVALID);
    }
    const locked = await call("/two-factor/disable", { body: { password: PASSWORD, code: await totpFor(person.id) }, headers });
    assert.equal(locked.status, 429);
    assert.equal(code(locked), TWO_FACTOR_TOO_MANY_ATTEMPTS);
    const inSession = await call("/two-factor/verify-totp", { body: { code: await totpFor(person.id) }, headers });
    assert.equal(inSession.status, 429, "the in-session verify shares the budget");

    const backup = await call("/two-factor/disable", { body: { password: PASSWORD, code: person.backupCodes[0] }, headers });
    assert.equal(backup.status, 200, JSON.stringify(backup.json));
  });

  it("regenerates backup codes only with a code, and the old ones stop working", async () => {
    const person = await enrol(await signUp());
    const headers = bearerHeaders(person.token);
    const refused = await call("/two-factor/generate-backup-codes", { body: { password: PASSWORD }, headers });
    assert.equal(code(refused), TWO_FACTOR_CODE_REQUIRED);

    const fresh = await call("/two-factor/generate-backup-codes", { body: { password: PASSWORD, code: await totpFor(person.id) }, headers });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
    const codes = fresh.json?.backupCodes as string[];
    assert.equal(codes.length, 10);

    const old = await verifyWithHeader((await challenge(person)).value, person.backupCodes[1]!, { path: "/two-factor/verify-backup-code" });
    assert.equal(old.status, 401);
    const replacement = await verifyWithHeader((await challenge(person)).value, codes[0]!, { path: "/two-factor/verify-backup-code" });
    assert.equal(replacement.status, 200);
  });
});

describe("deleting an account with 2FA on", () => {
  it("needs a correct code as well as the password", async () => {
    const person = await enrol(await signUp());
    const headers = bearerHeaders(person.token);
    const noCode = await call("/delete-user", { body: { password: PASSWORD }, headers });
    assert.equal(code(noCode), TWO_FACTOR_CODE_REQUIRED);
    const wrong = await call("/delete-user", { body: { password: PASSWORD, code: await wrongTotpFor(person.id) }, headers });
    assert.equal(code(wrong), TWO_FACTOR_CODE_INVALID);
    assert.ok(userRow(person.id));

    const done = await call("/delete-user", { body: { password: PASSWORD, code: await totpFor(person.id) }, headers });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(userRow(person.id), undefined);
  });

  it("deletes an account without 2FA on its password alone", async () => {
    const person = await signUp();
    const done = await call("/delete-user", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    assert.equal(done.status, 200, JSON.stringify(done.json));
  });

  it("asks no code once the enrolment row is gone (a half-finished deletion)", async () => {
    const person = await enrol(await signUp());
    db.twoFactor.splice(db.twoFactor.findIndex((row) => row.userId === person.id), 1);
    const done = await call("/delete-user", { body: { password: PASSWORD }, headers: bearerHeaders(person.token) });
    assert.notEqual(code(done), TWO_FACTOR_CODE_REQUIRED);
  });
});

describe("step-up for minting an API token", () => {
  it("marks the session a verify created or proved, for ten minutes", async () => {
    const person = await enrol(await signUp());
    const { value } = await challenge(person);
    const verified = await verifyWithHeader(value, await totpFor(person.id));
    const token = verified.headers.get("set-auth-token");
    assert.ok(token);
    const session = await sessionFor(bearerHeaders(token));
    assert.ok(session);
    assert.ok(await hasLiveStepUp(await adapter(), session.session.id));
    await assertTwoFactorStepUp(await adapter(), session);

    // Ten minutes on, the marker is gone and minting asks again.
    for (const row of db.verification) {
      if (String(row.identifier).startsWith("2fa-fresh-")) row.expiresAt = new Date(Date.now() - 1);
    }
    await assert.rejects(assertTwoFactorStepUp(await adapter(), session), (error: Error) =>
      error.message === TWO_FACTOR_STEP_UP_REQUIRED);

    // A code verified from inside the session marks it again, without rotating it.
    const stepUp = await call("/two-factor/verify-totp", { body: { code: await totpFor(person.id) }, headers: bearerHeaders(token) });
    assert.equal(stepUp.status, 200, JSON.stringify(stepUp.json));
    assert.equal((await sessionFor(bearerHeaders(token)))?.session.id, session.session.id);
    await assertTwoFactorStepUp(await adapter(), session);
  });

  it("asks nothing of an account without 2FA", async () => {
    const person = await signUp();
    const session = await sessionFor(bearerHeaders(person.token));
    assert.ok(session);
    await assertTwoFactorStepUp(await adapter(), session);
  });
});

describe("a dead session out of the cookie cache", () => {
  async function deadJar(): Promise<{ person: Enrolled; cookies: string }> {
    const person = await enrol(await signUp());
    const cookies = await browserSignIn(person);
    assert.ok(cookies.includes("session_data"), cookies);
    // Signed out everywhere: the rows are gone, the browser's cache cookie is not.
    for (let i = db.session.length - 1; i >= 0; i -= 1) {
      if (db.session[i]!.userId === person.id) db.session.splice(i, 1);
    }
    return { person, cookies };
  }

  it("cannot enable, disable, regenerate or verify a code", async () => {
    const { person, cookies } = await deadJar();
    const headers = { cookie: cookies };
    for (const [path, body] of [
      ["/two-factor/enable", { password: PASSWORD }],
      ["/two-factor/disable", { password: PASSWORD, code: await totpFor(person.id) }],
      ["/two-factor/generate-backup-codes", { password: PASSWORD, code: person.backupCodes[0] }],
      ["/two-factor/verify-totp", { code: await totpFor(person.id) }],
    ] as const) {
      const reply = await call(path, { body, headers });
      assert.equal(reply.status, 401, `${path}: ${JSON.stringify(reply.json)}`);
    }
  });

  it("cannot approve a device code or change the account", async () => {
    const { person, cookies } = await deadJar();
    const device = await call("/device/code", { body: { client_id: "trackyourtime-cli" } });
    const userCode = String(device.json?.user_code);
    const approve = await call("/device/approve", { body: { userCode }, headers: { cookie: cookies } });
    assert.equal(approve.status, 401);
    const rename = await call("/update-user", { body: { name: "renamed" }, headers: { cookie: cookies } });
    assert.equal(rename.status, 401);
    assert.notEqual(userRow(person.id).name, "renamed");
  });
});

describe("Google sign-in for a 2FA account", () => {
  /** The real `/callback/google`, end to end, with only Google's token endpoint stubbed. */
  async function googleCallback(email: string): Promise<Reply> {
    const realFetch = globalThis.fetch;
    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const idToken = [
      b64({ alg: "RS256", kid: "test" }),
      b64({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, sub: `google-${email}`, email, email_verified: true, name: "G", iat: now, exp: now + 600 }),
      "signature",
    ].join(".");
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "access", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;
    try {
      const start = await call("/sign-in/social", { body: { provider: "google", callbackURL: "/track" } });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      const state = new URL(String(start.json?.url)).searchParams.get("state") ?? "";
      return await call(`/callback/google?code=google-code&state=${encodeURIComponent(state)}`, {
        method: "GET",
        headers: { cookie: jar(start.headers) },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("gives a verified 2FA account no session through the callback", async () => {
    const person = await enrol(await signUp());
    // A verified address is what lets better-auth link Google to the account.
    userRow(person.id).emailVerified = true;
    const sessionsBefore = db.session.length;
    const reply = await googleCallback(person.email);
    assert.equal(reply.status, 302);
    assert.match(String(reply.headers.get("location")), /error=/);
    assert.ok(!jar(reply.headers).includes("session_token"), "no session cookie");
    assert.equal(db.session.length, sessionsBefore, "no session row was written");
  });

  it("still signs in an account without 2FA", async () => {
    const person = await signUp();
    userRow(person.id).emailVerified = true;
    const reply = await googleCallback(person.email);
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.get("location"), "/track");
    assert.ok(await sessionFor({ cookie: jar(reply.headers) }));
  });
});

describe("the device flow for a 2FA user", () => {
  it("approves from a session that came through the challenge", async () => {
    const person = await enrol(await signUp());
    const verified = await verifyWithHeader((await challenge(person)).value, await totpFor(person.id));
    const browser = verified.headers.get("set-auth-token");
    assert.ok(browser);

    const device = await auth.api.deviceCode({ body: { client_id: "trackyourtime-raycast" } });
    await auth.api.deviceVerify({ query: { user_code: device.user_code }, headers: new Headers(bearerHeaders(browser)) });
    await auth.api.deviceApprove({ body: { userCode: device.user_code }, headers: new Headers(bearerHeaders(browser)) });
    const issued = await auth.api.deviceToken({
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "trackyourtime-raycast",
      },
    });
    assert.ok(issued.access_token, "the paired client needs no second factor of its own");
    assert.equal((await sessionFor(bearerHeaders(issued.access_token)))?.user.id, person.id);
  });
});

describe("account controls", () => {
  it("change-password with revokeOtherSessions removes the other sessions and sweeps sockets", async () => {
    const person = await signUp();
    const other = (await signIn(person.email)).headers.get("set-auth-token");
    assert.ok(other);
    const sweepsBefore = sweeps;
    const changed = await call("/change-password", {
      body: { currentPassword: PASSWORD, newPassword: "new-password-5678", revokeOtherSessions: true },
      headers: bearerHeaders(person.token),
    });
    assert.ok(changed.headers.get("set-auth-token"), "the device that changed it keeps a session");
    assert.equal(await sessionFor(bearerHeaders(other)), null);
    assert.equal(db.session.filter((row) => row.userId === person.id).length, 1);
    assert.ok(sweeps > sweepsBefore, "the socket sweep ran");
  });

  it("change-password keeps working for a 2FA account (it is on the allowlist)", async () => {
    const person = await enrol(await signUp());
    const changed = await call("/change-password", {
      body: { currentPassword: PASSWORD, newPassword: "new-password-5678", revokeOtherSessions: true },
      headers: bearerHeaders(person.token),
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.ok(changed.headers.get("set-auth-token"));
  });

  it("a password reset signs every device out, sweeps sockets and keeps 2FA on", async () => {
    const person = await enrol(await signUp());
    const other = (await verifyWithHeader((await challenge(person)).value, await totpFor(person.id))).headers.get("set-auth-token");
    assert.ok(other);
    const asked = await call("/request-password-reset", { body: { email: person.email, redirectTo: `${BASE}/reset-password` } });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const sweepsBefore = sweeps;
    const reset = await call("/reset-password", { body: { newPassword: "a brand new passphrase", token: resetTokens.at(-1) } });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));

    assert.equal(await sessionFor(bearerHeaders(person.token)), null);
    assert.equal(await sessionFor(bearerHeaders(other)), null);
    assert.equal(db.session.filter((row) => row.userId === person.id).length, 0);
    assert.ok(sweeps > sweepsBefore, "the socket sweep ran");
    // The reset proved the inbox, not the second factor.
    assert.equal(userRow(person.id).twoFactorEnabled, true);
    const next = await call("/sign-in/email", { body: { email: person.email, password: "a brand new passphrase" } });
    assert.equal(next.json?.twoFactorRedirect, true);
  });

  it("change-email mails a verification link to the new address", async () => {
    const person = await signUp();
    await call("/change-email", {
      body: { newEmail: "moved@example.com", callbackURL: `${BASE}/settings` },
      headers: bearerHeaders(person.token),
    });
    const mail = sent.at(-1);
    assert.equal(mail?.to, "moved@example.com");
    assert.match(mail?.url ?? "", /verify-email\?token=/);
  });

  it("resolves the public auth config", () => {
    assert.deepEqual(
      resolveAuthConfig({ googleClientId: "id", googleClientSecret: "", emailDeliveryConfigured: false }),
      { googleEnabled: false, emailVerificationRequired: false },
    );
    assert.deepEqual(
      resolveAuthConfig({ googleClientId: "id", googleClientSecret: "secret", emailDeliveryConfigured: true }),
      { googleEnabled: true, emailVerificationRequired: true },
    );
  });
});

describe("backfill-email-verified", () => {
  it("marks accounts created before the cutoff verified, once", async () => {
    const early = await signUp();
    userRow(early.id).emailVerified = false;
    const cutoff = new Date(Date.now() + 1000);
    const late = await signUp();
    userRow(late.id).emailVerified = false;
    userRow(late.id).createdAt = new Date(Date.now() + 60_000);

    const context = await auth.$context;
    const first = await backfillEmailVerified(context.adapter, cutoff);
    assert.ok(first >= 1);
    assert.equal(userRow(early.id).emailVerified, true);
    assert.equal(userRow(late.id).emailVerified, false, "an account made after deploy verifies itself");
    assert.equal(await backfillEmailVerified(context.adapter, cutoff), 0, "a re-run changes nothing");
  });
});

it("mail-free owner signup succeeds without logging a verification link", async () => {
  const store = { user: [], session: [], account: [], verification: [] };
  let sends = 0;
  const localAuth = betterAuth({
    database: memoryAdapter(store),
    secret: "mail-free-recovery-test-secret-0123456789abcdef",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    emailVerification: emailVerificationOptions(async () => {
      sends += 1;
      throw new Error("Mail and log recovery are disabled");
    }, undefined, false),
  });
  const result = await localAuth.api.signUpEmail({
    body: { name: "Owner", email: "owner-recovery@example.test", password: PASSWORD },
  });
  assert.ok(result.token);
  assert.equal(sends, 0);
});
