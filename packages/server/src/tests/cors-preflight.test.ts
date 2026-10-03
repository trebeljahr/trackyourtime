import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { env } from "../config/env.js";

const WEB = "https://web.cors.test";
const CHROME = `chrome-extension://${"a".repeat(32)}`;
const FIREFOX = "moz-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d";
const SAFARI = "safari-web-extension://84C64C82-8F58-4B7B-A79D-274A513C8F8D";
const REQUEST_HEADERS = "authorization,content-type,x-trackyourtime-client,x-trackyourtime-client-version,x-trackyourtime-api-level";

describe("application CORS preflight caching", () => {
  let server: Server;
  let base: string;
  const previous = {
    FRONTEND_URL: env.FRONTEND_URL,
    TRUSTED_ORIGINS: env.TRUSTED_ORIGINS,
    TRUST_STORE_APPS: env.TRUST_STORE_APPS,
    TRUST_EXTENSION_ORIGINS: env.TRUST_EXTENSION_ORIGINS,
  };

  before(async () => {
    Object.assign(env, {
      FRONTEND_URL: WEB,
      TRUSTED_ORIGINS: `capacitor://localhost,${CHROME}`,
      TRUST_STORE_APPS: false,
      TRUST_EXTENSION_ORIGINS: "true",
    });
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    Object.assign(env, previous);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const origin of [WEB, "capacitor://localhost", CHROME, FIREFOX, SAFARI]) {
    it(`caches permitted preflights for ${origin}`, async () => {
      for (const path of ["/api/trpc/entries.current?batch=1", "/api/auth/get-session", "/api/v1/entries"]) {
        const response = await fetch(`${base}${path}`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": REQUEST_HEADERS,
          },
        });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-max-age"), "600");
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.equal(response.headers.get("access-control-allow-credentials"),
          origin === FIREFOX || origin === SAFARI ? null : "true");
        assert.equal(response.headers.get("access-control-allow-headers"), REQUEST_HEADERS);
        assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
        assert.match(response.headers.get("vary") ?? "", /Origin/);
        assert.match(response.headers.get("vary") ?? "", /Access-Control-Request-Headers/);
      }
      const actual = await fetch(`${base}/api/health`, { headers: { origin } });
      assert.equal(actual.headers.get("access-control-expose-headers"), "set-auth-token");
      assert.equal(actual.headers.get("access-control-max-age"), null);
    });
  }

  it("does not grant access to unlisted or malformed origins or cookie-bearing extensions", async () => {
    const cases = [
      { origin: "https://untrusted.cors.test" },
      { origin: `${WEB}.evil.test` },
      { origin: `chrome-extension://${"b".repeat(32)}` },
      { origin: "moz-extension://not-a-uuid" },
      { origin: FIREFOX, cookie: "better-auth.session_token=fake" },
      { origin: SAFARI, cookie: "__Secure-better-auth.session_token=fake" },
    ];
    for (const headers of cases) {
      // A max-age alone cannot grant CORS access: browsers must accept the
      // allow-origin header before storing a successful preflight result.
      const response = await fetch(`${base}/api/trpc/entries.current`, {
        method: "OPTIONS",
        headers: { ...headers, "access-control-request-method": "GET" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  });

  it("still refuses extension origins when their trust switch is off", async () => {
    Object.assign(env, { TRUST_EXTENSION_ORIGINS: "false" });
    try {
      const response = await fetch(`${base}/api/trpc/entries.current`, {
        method: "OPTIONS",
        headers: { origin: FIREFOX, "access-control-request-method": "GET" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    } finally {
      Object.assign(env, { TRUST_EXTENSION_ORIGINS: "true" });
    }
  });
});
