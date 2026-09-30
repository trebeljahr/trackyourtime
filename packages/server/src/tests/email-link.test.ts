import assert from "node:assert/strict";
import { it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailLinkForWeb } from "../auth/email-link.js";
import { emailVerificationOptions } from "../auth/account-security.js";

for (const frontend of [
  "https://trackyourtime.dev",
  "https://time.example.test",
]) {
  for (const callback of [
    "https://localhost/login/?next=%2Fapp%2Ftrack%2F",
    "capacitor://localhost/login/?next=%2Fapp%2Ftrack%2F",
    "/login/?next=%2Fapp%2Ftrack%2F",
  ]) {
    it(`keeps the verification token and uses ${frontend} for ${callback}`, () => {
      const input = new URL(
        "https://api.example.test/api/auth/verify-email?token=unchanged",
      );
      input.searchParams.set("callbackURL", callback);
      const result = new URL(emailLinkForWeb(input.href, frontend));
      assert.equal(result.origin, input.origin);
      assert.equal(result.searchParams.get("token"), "unchanged");
      assert.equal(
        result.searchParams.get("callbackURL"),
        `${frontend}/login/?next=%2Fapp%2Ftrack%2F`,
      );
    });
  }
}
it("never lets a callback pathname switch the destination host", () => {
  const link = new URL(
    "https://api.example.test/api/auth/verify-email?token=x",
  );
  link.searchParams.set("callbackURL", "https://localhost//evil.test/phish");
  assert.equal(
    new URL(
      emailLinkForWeb(link.href, "https://time.example.test"),
    ).searchParams.get("callbackURL"),
    "https://time.example.test/login",
  );
});
it("uses the reset page when the callback is absent", () => {
  assert.equal(
    new URL(
      emailLinkForWeb(
        "https://api.example.test/api/auth/reset-password/abc",
        "https://time.example.test",
      ),
    ).searchParams.get("callbackURL"),
    "https://time.example.test/reset-password",
  );
});

it("real auth verifies and resets through emailed links on a separate self-hosted web origin", async () => {
  const db = { user: [], session: [], account: [], verification: [] };
  let verification = "";
  let reset = "";
  const frontend = "https://time.example.test";
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "email-link-test-secret-0123456789abcdef",
    baseURL: "https://api.example.test",
    trustedOrigins: [frontend, "https://localhost"],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ url }) => {
        reset = emailLinkForWeb(url, frontend);
      },
    },
    emailVerification: emailVerificationOptions(
      async (url) => {
        verification = url;
      },
      undefined,
      true,
      frontend,
    ),
  });
  const post = (path: string, body: object) =>
    auth.handler(
      new Request(`https://api.example.test/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://localhost",
        },
        body: JSON.stringify(body),
      }),
    );
  const email = "pixel@example.test";
  const password = "a-safe-test-password-123";
  assert.equal(
    (
      await post("sign-up/email", {
        email,
        password,
        name: "Pixel QA",
        callbackURL: "https://localhost/login/?next=%2Fapp%2Ftrack%2F",
      })
    ).status,
    200,
  );
  assert.ok(verification);
  const verified = await auth.handler(new Request(verification));
  assert.equal(verified.status, 302);
  assert.equal(
    verified.headers.get("location"),
    `${frontend}/login/?next=%2Fapp%2Ftrack%2F`,
  );
  assert.equal((await post("sign-in/email", { email, password })).status, 200);
  assert.equal(
    (
      await post("request-password-reset", {
        email,
        redirectTo: "/reset-password",
      })
    ).status,
    200,
  );
  assert.ok(reset);
  const response = await auth.handler(new Request(reset));
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("location")!);
  assert.equal(destination.origin, frontend);
  assert.equal(destination.pathname, "/reset-password");
  assert.ok(destination.searchParams.get("token"));
});
