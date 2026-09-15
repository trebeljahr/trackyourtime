/**
 * Two-factor sign-in, against the real better-auth.
 *
 * Built from the same `auth/account-security.ts` pieces `auth/auth.ts`
 * registers, in the same plugin order, on better-auth's in-memory adapter —
 * no Mongo, no network. What it pins:
 *
 *  - a 2FA account gets no session and no bearer token from a password alone;
 *  - a TOTP code, computed here the way an authenticator app computes it from
 *    the enrolment URI, completes the challenge and only then yields a token;
 *  - a backup code completes it exactly once;
 *  - the challenge lives in a signed cookie, so a client that cannot send
 *    cookies cannot complete it (the spike result the native follow-up needs);
 *  - change-password with `revokeOtherSessions` removes every other session
 *    and triggers the socket sweep;
 *  - the email-verified backfill is idempotent.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";

import {
  emailVerificationOptions,
  resolveAuthConfig,
  sweepSocketsAfterRevocation,
  twoFactorPlugin,
  TWO_FACTOR_ISSUER,
} from "../auth/account-security.js";
import { backfillEmailVerified } from "../scripts/backfill-email-verified.js";

type Row = Record<string, unknown> & { id: string };
const db: Record<string, Row[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
  twoFactor: [],
};

const sent: { url: string; to: string }[] = [];
let sweeps = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

before(() => {
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "two-factor-integration-secret-0123456789abcdef",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    emailVerification: emailVerificationOptions(async (url, mail) => {
      sent.push({ url, to: mail.to });
    }),
    user: { changeEmail: { enabled: true } },
    hooks: { after: sweepSocketsAfterRevocation(() => (sweeps += 1)) },
    // Same order as auth/auth.ts — the order is the point, see account-security.ts.
    plugins: [
      twoFactorPlugin(),
      bearer(),
      deviceAuthorization({ expiresIn: "10m", interval: "5s" }),
    ],
  });
});

/* ------------------------------------------------------------------ TOTP -- */

const base32Decode = (input: string): Buffer => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    assert.ok(value >= 0, `not base32: ${char}`);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

/** RFC 6238, exactly what an authenticator app does with the scanned URI. */
const totpFromUri = (uri: string, at = Date.now()): string => {
  const url = new URL(uri);
  const secret = base32Decode(url.searchParams.get("secret") ?? "");
  const period = Number(url.searchParams.get("period") ?? 30);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
};

/* --------------------------------------------------------------- helpers -- */

/** `name=value` pairs from a response's `set-cookie`, live cookies only. */
const cookieHeader = (headers: Headers): string =>
  headers
    .getSetCookie()
    .filter((line) => !/max-age=0/i.test(line))
    .map((line) => line.split(";")[0])
    .join("; ");

let seq = 0;
const PASSWORD = "password1234";

async function newUser(): Promise<{ email: string; token: string; userId: string }> {
  seq += 1;
  const email = `two-factor-${seq}@example.com`;
  const response = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: `user ${seq}` },
    returnHeaders: true,
  });
  const token = response.headers.get("set-auth-token");
  assert.ok(token);
  return { email, token, userId: response.response.user.id };
}

const bearerHeaders = (token: string): Headers =>
  new Headers({ authorization: `Bearer ${token}` });

/**
 * Enable and confirm 2FA. Confirming replaces the session (the user row it
 * caches changed), so the token to keep using is the one it hands back.
 */
async function enrol(
  token: string,
): Promise<{ uri: string; backupCodes: string[]; token: string }> {
  const enabled = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: bearerHeaders(token),
  });
  const confirmed = await auth.api.verifyTOTP({
    body: { code: totpFromUri(enabled.totpURI) },
    headers: bearerHeaders(token),
    returnHeaders: true,
  });
  return {
    uri: enabled.totpURI,
    backupCodes: enabled.backupCodes,
    token: confirmed.headers.get("set-auth-token") ?? token,
  };
}

const signIn = (email: string) =>
  auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });

const userRow = (email: string): Row =>
  db.user.find((row) => row.email === email) as Row;

/* ----------------------------------------------------------------- tests -- */

describe("two-factor sign-in", () => {
  it("does not switch 2FA on until a code from the authenticator verifies", async () => {
    const { email, token } = await newUser();
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: bearerHeaders(token),
    });
    assert.match(enabled.totpURI, /^otpauth:\/\/totp\//);
    assert.ok(enabled.totpURI.includes(encodeURIComponent(TWO_FACTOR_ISSUER)));
    assert.equal(enabled.backupCodes.length, 10);
    assert.notEqual(userRow(email).twoFactorEnabled, true);

    // A password alone still signs in: the QR code was never confirmed.
    const unconfirmed = await signIn(email);
    assert.ok(unconfirmed.headers.get("set-auth-token"));

    await auth.api.verifyTOTP({
      body: { code: totpFromUri(enabled.totpURI) },
      headers: bearerHeaders(token),
    });
    assert.equal(userRow(email).twoFactorEnabled, true);
  });

  it("gives a password alone no session and no bearer token", async () => {
    const { email, token } = await newUser();
    await enrol(token);
    const sessionsBefore = db.session.length;

    const result = await signIn(email);
    assert.equal(result.response.twoFactorRedirect, true);
    assert.deepEqual(result.response.twoFactorMethods, ["totp"]);
    // The extension and the mobile bundle read this header; its absence is
    // what turns the attempt into an error rather than a stored token.
    assert.equal(result.headers.get("set-auth-token"), null);
    assert.equal(db.session.length, sessionsBefore, "the password session is deleted again");
    assert.match(cookieHeader(result.headers), /two_factor=/);
    // The session cookie the password set is expired again in the same response.
    const sessionCookies = result.headers
      .getSetCookie()
      .filter((line: string) => line.includes("session_token="));
    assert.match(sessionCookies.at(-1) ?? "", /max-age=0/i);
  });

  it("completes with a TOTP code, and only then issues a bearer token", async () => {
    const { email, token } = await newUser();
    const { uri } = await enrol(token);
    const challenge = await signIn(email);

    const verified = await auth.api.verifyTOTP({
      body: { code: totpFromUri(uri) },
      headers: new Headers({ cookie: cookieHeader(challenge.headers) }),
      returnHeaders: true,
    });
    const issued = verified.headers.get("set-auth-token");
    assert.ok(issued, "a bearer token after the second factor");
    const session = await auth.api.getSession({ headers: bearerHeaders(issued) });
    assert.equal(session?.user.email, email);
  });

  it("refuses a wrong code", async () => {
    const { email, token } = await newUser();
    const { uri } = await enrol(token);
    const challenge = await signIn(email);
    const right = totpFromUri(uri);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    await assert.rejects(
      auth.api.verifyTOTP({
        body: { code: wrong },
        headers: new Headers({ cookie: cookieHeader(challenge.headers) }),
      }),
      (error: { body?: { code?: string } }) => error.body?.code === "INVALID_CODE",
    );
  });

  it("accepts a backup code exactly once", async () => {
    const { email, token } = await newUser();
    const { backupCodes } = await enrol(token);
    const [code] = backupCodes;

    const first = await signIn(email);
    const used = await auth.api.verifyBackupCode({
      body: { code },
      headers: new Headers({ cookie: cookieHeader(first.headers) }),
      returnHeaders: true,
    });
    assert.ok(used.headers.get("set-auth-token"));

    const second = await signIn(email);
    await assert.rejects(
      auth.api.verifyBackupCode({
        body: { code },
        headers: new Headers({ cookie: cookieHeader(second.headers) }),
      }),
      (error: { body?: { code?: string } }) => error.body?.code === "INVALID_BACKUP_CODE",
    );
  });

  it("cannot be completed bearer-only: the challenge is the signed cookie", async () => {
    // Spike for the native-clients follow-up. A WKWebView or extension fetch
    // cannot read set-cookie or send Cookie, so all it has is the response
    // body — and the body carries no challenge.
    const { email, token } = await newUser();
    const { uri } = await enrol(token);
    const challenge = await signIn(email);
    assert.deepEqual(Object.keys(challenge.response).sort(), ["twoFactorMethods", "twoFactorRedirect"]);

    await assert.rejects(
      auth.api.verifyTOTP({ body: { code: totpFromUri(uri) }, headers: new Headers() }),
      (error: { body?: { code?: string } }) => error.body?.code === "INVALID_TWO_FACTOR_COOKIE",
    );
  });

  it("leaves the device flow working: a 2FA-verified browser approves, Raycast gets a token", async () => {
    const { email, token } = await newUser();
    const { uri } = await enrol(token);
    const challenge = await signIn(email);
    const verified = await auth.api.verifyTOTP({
      body: { code: totpFromUri(uri) },
      headers: new Headers({ cookie: cookieHeader(challenge.headers) }),
      returnHeaders: true,
    });
    const browser = verified.headers.get("set-auth-token");
    assert.ok(browser);

    const code = await auth.api.deviceCode({ body: { client_id: "trackyourtime-raycast" } });
    // /app/device claims the code for the signed-in browser, then it approves.
    await auth.api.deviceVerify({
      query: { user_code: code.user_code },
      headers: bearerHeaders(browser),
    });
    await auth.api.deviceApprove({
      body: { userCode: code.user_code },
      headers: bearerHeaders(browser),
    });
    const issued = await auth.api.deviceToken({
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "trackyourtime-raycast",
      },
    });
    assert.ok(issued.access_token, "the paired client needs no second factor of its own");
    const session = await auth.api.getSession({ headers: bearerHeaders(issued.access_token) });
    assert.equal(session?.user.email, email);
  });

  it("disabling needs the password", async () => {
    const { email, token: first } = await newUser();
    const { token } = await enrol(first);
    await assert.rejects(
      auth.api.disableTwoFactor({ body: { password: "wrong-password" }, headers: bearerHeaders(token) }),
    );
    assert.equal(userRow(email).twoFactorEnabled, true);
    await auth.api.disableTwoFactor({ body: { password: PASSWORD }, headers: bearerHeaders(token) });
    assert.equal(userRow(email).twoFactorEnabled, false);
    const plain = await signIn(email);
    assert.ok(plain.headers.get("set-auth-token"));
  });
});

describe("auth/auth.ts wiring", () => {
  it("registers two-factor ahead of bearer", () => {
    // Swapping them still type-checks and still passes every test above that
    // builds its own instance, while the bearer hook starts issuing a token
    // for the deleted password session. So the real file is read.
    const source = readFileSync(new URL("../auth/auth.ts", import.meta.url), "utf8");
    const twoFactorAt = source.indexOf("twoFactorPlugin(),");
    const bearerAt = source.indexOf("bearer(),");
    assert.ok(twoFactorAt > 0 && bearerAt > 0, "both plugins are registered");
    assert.ok(twoFactorAt < bearerAt, "twoFactorPlugin() must come before bearer()");
  });
});

describe("account controls", () => {
  it("change-password with revokeOtherSessions removes the other sessions and sweeps sockets", async () => {
    const { email, token, userId } = await newUser();
    const other = await signIn(email);
    const otherToken = other.headers.get("set-auth-token");
    assert.ok(otherToken);
    const sweepsBefore = sweeps;

    const changed = await auth.api.changePassword({
      body: { currentPassword: PASSWORD, newPassword: "new-password-5678", revokeOtherSessions: true },
      headers: bearerHeaders(token),
      returnHeaders: true,
    });
    const replacement = changed.headers.get("set-auth-token");
    assert.ok(replacement, "the device that changed it keeps a session");

    assert.equal(await auth.api.getSession({ headers: bearerHeaders(otherToken), query: { disableCookieCache: true } }), null);
    assert.equal(db.session.filter((row) => row.userId === userId).length, 1);
    assert.ok(sweeps > sweepsBefore, "the socket sweep ran");
  });

  it("change-email mails a verification link to the new address", async () => {
    const { token } = await newUser();
    await auth.api.changeEmail({
      body: { newEmail: "moved@example.com", callbackURL: "http://localhost:3392/settings" },
      headers: bearerHeaders(token),
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
    const { email: early } = await newUser();
    userRow(early).emailVerified = false;
    const cutoff = new Date(Date.now() + 1000);
    const { email: late } = await newUser();
    userRow(late).emailVerified = false;
    userRow(late).createdAt = new Date(Date.now() + 60_000);

    const context = await auth.$context;
    const first = await backfillEmailVerified(context.adapter, cutoff);
    assert.ok(first >= 1);
    assert.equal(userRow(early).emailVerified, true);
    assert.equal(userRow(late).emailVerified, false, "an account made after deploy verifies itself");

    const second = await backfillEmailVerified(context.adapter, cutoff);
    assert.equal(second, 0, "a re-run changes nothing");
  });
});
