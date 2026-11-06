/**
 * `signInWithPassword` against a server with password unlock: the typed
 * password stays on the device for an upgraded account, a legacy account
 * still receives it, and a cut-off upgrade tries both.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signInWithPassword } from "../session-auth.js";
import { derivePasswordKeys, LOGIN_SECRET_PREFIX } from "../privacy/crypto.js";

const kdf = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: "AAECAwQFBgcICQoLDA0ODw" } as const;
const server = (state: string, accepts: (password: string) => boolean) => {
  const sent: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/trpc/accountPassword.kdf")) {
      assert.match(decodeURIComponent(url), /"email":"alice@example.com"/);
      return new Response(JSON.stringify({ result: { data: { state, kdf } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { password: string };
    sent.push(body.password);
    return accepts(body.password)
      ? new Response(JSON.stringify({ token: "raw", user: { id: "u1" } }), { status: 200, headers: { "set-auth-token": "signed.token" } })
      : new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }), { status: 401 });
  }) as typeof fetch;
  return { sent, options: { baseUrl: "http://localhost:5159", clientId: "trackyourtime-extension", fetchImpl } };
};
const credentials = { email: "alice@example.com", password: "password1234" };

describe("signInWithPassword with password unlock", () => {
  it("sends only the derived login secret to an upgraded account", async () => {
    const expected = (await derivePasswordKeys(credentials.password, kdf)).loginSecret;
    const s = server("ready", (password) => password === expected);
    assert.equal((await signInWithPassword(s.options, credentials)).token, "signed.token");
    assert.deepEqual(s.sent, [expected]);
    assert.ok(s.sent[0]!.startsWith(LOGIN_SECRET_PREFIX));
  });
  it("sends the typed password to a legacy account", async () => {
    const s = server("legacy", (password) => password === credentials.password);
    await signInWithPassword(s.options, credentials);
    assert.deepEqual(s.sent, [credentials.password]);
  });
  it("tries the typed password, then the derived one, for a cut-off upgrade", async () => {
    const s = server("pending", (password) => password.startsWith(LOGIN_SECRET_PREFIX));
    await signInWithPassword(s.options, credentials);
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[0], credentials.password);
  });
});
