/**
 * `signInWithPassword` for a two-factor account.
 *
 * The server answers a correct password with `{ twoFactorRedirect: true }`,
 * a challenge cookie and no `set-auth-token`. Until the native clients can
 * carry the challenge, the extension must get a named error — never a token,
 * and never the misleading "is the bearer plugin enabled?".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuthError, signInWithPassword, TWO_FACTOR_UNSUPPORTED } from "../session-auth.js";

const respond = (body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    })) as typeof fetch;

describe("signInWithPassword and two-factor accounts", () => {
  it("throws TWO_FACTOR_UNSUPPORTED for a challenge", async () => {
    await assert.rejects(
      signInWithPassword(
        {
          baseUrl: "http://localhost:5159",
          clientId: "tracktime-extension",
          fetchImpl: respond(
            { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
            { "set-cookie": "better-auth.two_factor=2fa-x.sig; Path=/; HttpOnly" },
          ),
        },
        { email: "alice@example.com", password: "password1234" },
      ),
      (error: unknown) => error instanceof AuthError && error.code === TWO_FACTOR_UNSUPPORTED,
    );
  });

  it("still signs a plain account in", async () => {
    const issued = await signInWithPassword(
      {
        baseUrl: "http://localhost:5159",
        clientId: "tracktime-extension",
        fetchImpl: respond(
          { token: "raw", user: { id: "u1", email: "alice@example.com" } },
          { "set-auth-token": "signed.token" },
        ),
      },
      { email: "alice@example.com", password: "password1234" },
    );
    assert.equal(issued.token, "signed.token");
    assert.equal(issued.userId, "u1");
  });
});
