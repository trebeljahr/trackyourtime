import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins/magic-link";

import { magicLinkGuard } from "../auth/magic-link-guard.js";
import { twoFactorPlugin } from "../auth/account-security.js";

type Row = Record<string, unknown> & { id: string };

describe("magic-link sign-in", () => {
  it("signs in once, but never bypasses newly enabled two-factor", async () => {
    const db: Record<string, Row[]> = {
      user: [], session: [], account: [], verification: [],
    };
    const links: string[] = [];
    const auth = betterAuth({
      database: memoryAdapter(db as never),
      secret: "magic-link-integration-secret-0123456789abcdef",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      hooks: { before: magicLinkGuard },
      plugins: [twoFactorPlugin(), magicLink({
        disableSignUp: true,
        storeToken: "hashed",
        sendMagicLink: ({ url }) => { links.push(url); },
      })],
    });

    const email = "magic@example.com";
    await auth.api.signUpEmail({ body: { name: "Magic", email, password: "password1234" } });
    const user = db.user.find((row) => row.email === email);
    assert.ok(user);
    user.emailVerified = true;
    const existingSessions = db.session.length;
    await auth.api.signInMagicLink({ body: { email, callbackURL: "/app" }, headers: new Headers() });
    assert.equal(links.length, 1);
    assert.equal(db.verification.length, 1);
    assert.notEqual(db.verification[0].identifier, new URL(links[0]).searchParams.get("token"));

    // Turning 2FA on after the email is sent still blocks redemption.
    user.twoFactorEnabled = true;
    const blocked = await auth.handler(new Request(links[0], { redirect: "manual" }));
    assert.equal(blocked.status, 403);
    assert.equal(db.session.length, existingSessions);

    user.twoFactorEnabled = false;
    const signedIn = await auth.handler(new Request(links[0], { redirect: "manual" }));
    assert.equal(signedIn.status, 302);
    assert.equal(db.session.length, existingSessions + 1);
    const replay = await auth.handler(new Request(links[0], { redirect: "manual" }));
    assert.equal(db.session.length, existingSessions + 1);
    assert.notEqual(replay.headers.get("location"), "/app");
  });
});
