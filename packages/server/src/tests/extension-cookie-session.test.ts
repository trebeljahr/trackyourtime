/** Real auth endpoints, memory adapter, no browser credentials or network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";

const API = "https://api.example.test";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

test("a signed web cookie approves a separate extension session without a page", async () => {
  const auth = betterAuth({
    baseURL: API, secret: "extension-cookie-test-secret-0123456789abcdef",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], deviceCode: [] }),
    trustedOrigins: [ORIGIN, API],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [bearer(), deviceAuthorization({ expiresIn: "10m", interval: "5s" })],
  });
  const call = (path: string, body?: unknown, token?: string) => auth.handler(new Request(`${API}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const signup = await call("/sign-up/email", { name: "Test", email: "test@example.com", password: "safe-test-password-123" });
  assert.equal(signup.status, 200);
  const sessionCookie = signup.headers.getSetCookie().find((cookie) => cookie.split("=")[0].endsWith("session_token"));
  assert.ok(sessionCookie);
  const webToken = sessionCookie.split(";")[0].slice(sessionCookie.indexOf("=") + 1);
  const session = await (await call("/get-session?disableCookieCache=true", undefined, webToken)).json() as { user: { id: string; email: string } };
  assert.equal(session.user.email, "test@example.com");
  const codeResponse = await call("/device/code", { client_id: "trackyourtime-extension" });
  assert.equal(codeResponse.status, 200);
  const code = await codeResponse.json() as { user_code: string; device_code: string };
  assert.equal((await call(`/device?user_code=${code.user_code}`, undefined, webToken)).status, 200);
  assert.equal((await call("/device/approve", { userCode: code.user_code }, webToken)).status, 200);
  const tokenResponse = await call("/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "trackyourtime-extension", device_code: code.device_code,
  });
  assert.equal(tokenResponse.status, 200);
  const extension = await tokenResponse.json() as { access_token: string };
  assert.ok(extension.access_token);
  assert.notEqual(extension.access_token, webToken);
  assert.equal(((await (await call("/get-session", undefined, extension.access_token)).json()) as typeof session).user.id, session.user.id);
  assert.equal((await call("/sign-out", {}, extension.access_token)).status, 200);
  assert.equal(((await (await call("/get-session?disableCookieCache=true", undefined, webToken)).json()) as typeof session).user.id, session.user.id);
});
