/**
 * Trusting `moz-extension://<uuid>` against the real better-auth, and the real
 * `cors` middleware.
 *
 * `extension-origins.test.ts` pins the rule's arithmetic. It cannot pin the
 * claims that actually decide whether a Firefox extension can sign in, all
 * three of which are about libraries this repo does not own:
 *
 *  - better-auth calls `trustedOrigins` WITH the request, so a per-request
 *    origin is honoured at all;
 *  - a request carrying `Sec-Fetch-*` and no cookie — the exact shape a
 *    Firefox background page sends (docs/firefox-extension-spike.md) — is
 *    force-validated, and passes only because of that function;
 *  - the same request with a session cookie is refused, and the CORS answer
 *    for an extension origin carries no `Access-Control-Allow-Credentials`.
 *
 * Reading the source instead of running it is how the two-factor note in
 * CLAUDE.md got written the wrong way round once already.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import cors from "cors";
import express from "express";

import { trustedOriginsForRequest } from "../auth/extension-origins.js";
import { corsOptionsFor } from "../app.js";

const FIREFOX_ORIGIN = "moz-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d";
const WEB_ORIGIN = "https://trackyourtime.dev";
const BASE_URL = "http://localhost:3000";

const db = { user: [], session: [], account: [], verification: [] };

/**
 * The headers a Firefox extension's background `fetch` really sends, measured
 * in the spike. `Sec-Fetch-*` is the load-bearing part: better-auth skips
 * origin validation entirely for a request with neither cookies nor these
 * headers (which is why curl proves nothing here) and force-validates when
 * they are present.
 */
const extensionHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  origin: FIREFOX_ORIGIN,
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  ...extra,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

const makeAuth = (extensionsTrusted: boolean): unknown =>
  betterAuth({
    database: memoryAdapter(db as never),
    secret: "extension-origin-integration-secret-0123456789",
    baseURL: BASE_URL,
    emailAndPassword: { enabled: true },
    // The same call `auth/auth.ts` makes, so this test cannot pass against a
    // function the server does not use.
    trustedOrigins: (request?: Request) =>
      trustedOriginsForRequest([WEB_ORIGIN], request, extensionsTrusted),
    plugins: [bearer()],
  });

before(async () => {
  auth = makeAuth(true);
  await auth.api.signUpEmail({
    body: { email: "firefox@example.com", password: "password1234", name: "Firefox" },
  });
});

/** Sign in over the HTTP handler, so the origin middleware really runs. */
const signIn = (
  instance: { handler: (request: Request) => Promise<Response> },
  headers: Record<string, string>,
): Promise<Response> =>
  instance.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email: "firefox@example.com", password: "password1234" }),
    }),
  );

describe("better-auth and a random extension origin", () => {
  it("signs in from moz-extension:// when the request carries no cookie", async () => {
    const response = await signIn(auth, extensionHeaders());
    assert.equal(response.status, 200, await response.clone().text());
    // The bearer path really is what it got: a token it can store, and a
    // session it can use with credentials: "omit".
    assert.ok(response.headers.get("set-auth-token"));
  });

  it("refuses the same request once it carries a session cookie", async () => {
    const response = await signIn(
      auth,
      extensionHeaders({ cookie: "better-auth.session_token=someone-elses-session" }),
    );
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "INVALID_ORIGIN");
  });

  it("lets an unrelated cookie through, because a WebSocket cannot drop one", async () => {
    const response = await signIn(auth, extensionHeaders({ cookie: "__cf_bm=abc" }));
    assert.equal(response.status, 200);
  });

  it("refuses every extension origin while the server has not opted in", async () => {
    const closed = makeAuth(false) as { handler: (r: Request) => Promise<Response> };
    const response = await signIn(closed, extensionHeaders());
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, "INVALID_ORIGIN");
  });

  it("still refuses an origin that only looks like one", async () => {
    const response = await signIn(auth, {
      ...extensionHeaders(),
      origin: "moz-extension://not-a-uuid",
    });
    assert.equal(response.status, 403);
  });
});

describe("the CORS answer for an extension origin", () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    // The delegate `createApp()` mounts, with the switch forced on: env in the
    // test process has no TRUST_* set, and the subject here is the shape of
    // the answer, not the switch (which extension-origins.test.ts pins).
    app.use(
      cors((req, done) =>
        done(
          null,
          req.headers.origin === FIREFOX_ORIGIN && !req.headers.cookie
            ? { origin: FIREFOX_ORIGIN, credentials: false, exposedHeaders: ["set-auth-token"] }
            : corsOptionsFor(req as never),
        ),
      ),
    );
    app.get("/api/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("allows the origin and never allows credentials", async () => {
    const preflight = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: {
        origin: FIREFOX_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-trackyourtime-client",
      },
    });
    assert.equal(preflight.headers.get("access-control-allow-origin"), FIREFOX_ORIGIN);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    // Header names are still reflected: trust is decided by origin alone.
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /x-trackyourtime-client/,
    );

    const actual = await fetch(`${base}/api/health`, { headers: { origin: FIREFOX_ORIGIN } });
    assert.equal(actual.headers.get("access-control-allow-origin"), FIREFOX_ORIGIN);
    assert.equal(actual.headers.get("access-control-allow-credentials"), null);
    assert.equal(actual.headers.get("access-control-expose-headers"), "set-auth-token");
  });
});
