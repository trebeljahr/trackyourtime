/**
 * The extension-scheme trust rule, and the two switches that turn it on.
 *
 * `extension-origin-integration.test.ts` runs the same rule through the real
 * better-auth and a real Express app; this file pins the arithmetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  carriesSessionCookie,
  extensionOriginTrusted,
  isRandomExtensionOrigin,
  trustedOriginsForRequest,
} from "../auth/extension-origins.js";
import { resolveTrustExtensionOrigins } from "../config/env.js";
import { corsOptionsFor, extensionCorsOptions } from "../app.js";

const FIREFOX = "moz-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d";
const SAFARI = "safari-web-extension://84C64C82-8F58-4B7B-A79D-274A513C8F8D";

describe("extension origin shape", () => {
  it("accepts the two schemes that hand out a random per-install origin", () => {
    assert.equal(isRandomExtensionOrigin(FIREFOX), true);
    assert.equal(isRandomExtensionOrigin(SAFARI), true);
  });

  it("refuses anything that is not exactly one of those origins", () => {
    for (const origin of [
      // Chromium ids are derivable and pinned, so they are trusted by their
      // exact value or not at all — never by scheme.
      "chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi",
      "https://trackyourtime.dev",
      "moz-extension://not-a-uuid",
      // A path, a port or userinfo means somebody composed the string.
      `${FIREFOX}/popup.html`,
      `${FIREFOX}:443`,
      "moz-extension://user@42a04a0c-c28d-4f59-8694-9623ce55de3d",
      "https://moz-extension.example.com",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isRandomExtensionOrigin(origin), false, String(origin));
    }
  });
});

describe("session cookie detection", () => {
  it("finds better-auth's session cookie under any prefix", () => {
    assert.equal(carriesSessionCookie("better-auth.session_token=abc"), true);
    assert.equal(
      carriesSessionCookie("theme=dark; __Secure-better-auth.session_token=abc"),
      true,
    );
    assert.equal(carriesSessionCookie("myapp.session_token=abc"), true);
  });

  it("ignores cookies that are not a session", () => {
    // `__cf_bm` is SameSite=None, so it rides along on an extension's
    // WebSocket upgrade whatever the extension does (see the spike doc).
    // Reading it as "this is a cookie client" would kill the Firefox socket
    // for everybody behind that CDN.
    assert.equal(carriesSessionCookie("__cf_bm=abc; theme=dark"), false);
    assert.equal(carriesSessionCookie(""), false);
    assert.equal(carriesSessionCookie(undefined), false);
  });
});

describe("the rule", () => {
  it("trusts an extension origin that carries no session cookie", () => {
    assert.equal(
      extensionOriginTrusted({ origin: FIREFOX, cookie: undefined, enabled: true }),
      true,
    );
    assert.equal(
      extensionOriginTrusted({ origin: FIREFOX, cookie: "__cf_bm=x", enabled: true }),
      true,
    );
  });

  it("refuses one that carries a session cookie", () => {
    assert.equal(
      extensionOriginTrusted({
        origin: FIREFOX,
        cookie: "better-auth.session_token=abc",
        enabled: true,
      }),
      false,
    );
  });

  it("refuses everything while the server has not opted in", () => {
    assert.equal(
      extensionOriginTrusted({ origin: FIREFOX, cookie: undefined, enabled: false }),
      false,
    );
  });

  it("adds only this request's own origin to the trusted list", () => {
    const listed = ["https://trackyourtime.dev"];
    const request = new Request("https://api.trackyourtime.dev/api/auth/sign-in/email", {
      headers: { origin: FIREFOX },
    });
    assert.deepEqual(trustedOriginsForRequest(listed, request, true), [
      "https://trackyourtime.dev",
      FIREFOX,
    ]);
    assert.deepEqual(trustedOriginsForRequest(listed, request, false), listed);
    assert.deepEqual(trustedOriginsForRequest(listed, undefined, true), listed);
  });
});

describe("TRUST_EXTENSION_ORIGINS", () => {
  it("follows TRUST_STORE_APPS when unset", () => {
    assert.equal(resolveTrustExtensionOrigins("", true), true);
    assert.equal(resolveTrustExtensionOrigins("", false), false);
  });

  it("wins over TRUST_STORE_APPS in both directions", () => {
    assert.equal(resolveTrustExtensionOrigins("false", true), false);
    assert.equal(resolveTrustExtensionOrigins("true", false), true);
    assert.equal(resolveTrustExtensionOrigins("off", true), false);
    assert.equal(resolveTrustExtensionOrigins("1", false), true);
  });
});

describe("CORS for an extension origin", () => {
  it("never allows credentials", () => {
    const options = extensionCorsOptions(FIREFOX);
    assert.equal(options.origin, FIREFOX);
    assert.equal(options.credentials, false);
    // The bearer plugin's token header still has to be readable.
    assert.deepEqual(options.exposedHeaders, ["set-auth-token"]);
  });

  it("falls back to the static, credentialed options for every other origin", () => {
    // TRUST_EXTENSION_ORIGINS is unset and TRUST_STORE_APPS off in the test
    // environment, so even an extension origin takes the static path here.
    const options = corsOptionsFor({ headers: { origin: FIREFOX } });
    assert.equal(options.credentials, true);
  });
});
