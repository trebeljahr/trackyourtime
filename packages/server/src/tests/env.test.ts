import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  STORE_APP_ORIGINS,
  STORE_EXTENSION_ID,
  STORE_EXTENSION_KEY,
} from "@starter/shared";
import {
  buildTrustedOrigins,
  env,
  getTrustedOrigins,
  resolveAppUrls,
} from "../config/env.js";

// These assert the contract of getTrustedOrigins() against whatever env is
// actually loaded, rather than a hardcoded localhost port — this project's
// dev ports are assigned by scripts/dev.mjs, so a literal port here fails
// for reasons that have nothing to do with the code under test.

test("trusted origins lead with the configured frontend URL", () => {
  const origins = getTrustedOrigins();
  assert.ok(Array.isArray(origins));

  if (env.FRONTEND_URL) {
    assert.equal(origins[0], env.FRONTEND_URL);
  } else {
    assert.deepEqual(origins, []);
  }
});

test("trusted origins merge in the TRUSTED_ORIGINS csv", () => {
  const extras = env.TRUSTED_ORIGINS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const origins = getTrustedOrigins();
  for (const extra of extras) {
    assert.ok(
      origins.includes(extra),
      `expected trusted origins to include ${extra}`,
    );
  }
});

// APP_URL is the single-domain shortcut: one URL that supplies both of the
// two the split hosted deploy sets separately. resolveAppUrls takes nodeEnv
// as an argument rather than reading process.env, so the production-only
// throw can be asserted without mutating the environment the other tests run
// against.
const APP = "https://track.example.com";
const WEB = "https://tracktime.example.com";
const API = "https://api.tracktime.example.com";

test("APP_URL alone supplies both auth URLs", () => {
  const resolved = resolveAppUrls(
    { appUrl: APP, frontendUrl: "", betterAuthUrl: "" },
    "production",
  );
  assert.equal(resolved.frontendUrl, APP);
  assert.equal(resolved.betterAuthUrl, APP);
});

test("APP_URL loses its trailing slash", () => {
  const resolved = resolveAppUrls(
    { appUrl: `${APP}//`, frontendUrl: "", betterAuthUrl: "" },
    "production",
  );
  assert.equal(resolved.frontendUrl, APP);
  assert.equal(resolved.betterAuthUrl, APP);
});

test("explicit URLs work with no APP_URL, and may differ from each other", () => {
  const resolved = resolveAppUrls(
    { appUrl: "", frontendUrl: WEB, betterAuthUrl: API },
    "production",
  );
  assert.equal(resolved.frontendUrl, WEB);
  assert.equal(resolved.betterAuthUrl, API);
});

test("explicit URLs win over APP_URL", () => {
  // The hosted deploy sets both to two different hosts. Whatever APP_URL says,
  // that split must survive untouched.
  const resolved = resolveAppUrls(
    { appUrl: APP, frontendUrl: WEB, betterAuthUrl: API },
    "production",
  );
  assert.equal(resolved.frontendUrl, WEB);
  assert.equal(resolved.betterAuthUrl, API);
});

test("one explicit URL still lets the other derive from APP_URL", () => {
  const resolved = resolveAppUrls(
    { appUrl: APP, frontendUrl: WEB, betterAuthUrl: "" },
    "production",
  );
  assert.equal(resolved.frontendUrl, WEB);
  assert.equal(resolved.betterAuthUrl, APP);
});

test("no URL at all throws in production, naming APP_URL as the alternative", () => {
  assert.throws(
    () =>
      resolveAppUrls(
        { appUrl: "", frontendUrl: "", betterAuthUrl: "" },
        "production",
      ),
    /BETTER_AUTH_URL \(or set APP_URL\)/,
  );
  assert.throws(
    () =>
      resolveAppUrls({ appUrl: "", frontendUrl: "", betterAuthUrl: API }, "production"),
    /FRONTEND_URL \(or set APP_URL\)/,
  );
});

test("outside production a missing URL is empty rather than fatal", () => {
  const resolved = resolveAppUrls(
    { appUrl: "", frontendUrl: "", betterAuthUrl: "" },
    "development",
  );
  assert.equal(resolved.frontendUrl, "");
  assert.equal(resolved.betterAuthUrl, "");
});

// ── TRUST_STORE_APPS ─────────────────────────────────────────────────

test("store apps are trusted only when the switch is on", () => {
  const base = {
    frontendUrl: APP,
    trustedOrigins: "",
    isProduction: true,
  };
  assert.deepEqual(buildTrustedOrigins({ ...base, trustStoreApps: false }), [
    APP,
  ]);
  assert.deepEqual(buildTrustedOrigins({ ...base, trustStoreApps: true }), [
    APP,
    ...STORE_APP_ORIGINS,
  ]);
});

test("store apps sit beside TRUSTED_ORIGINS, never replace it", () => {
  const origins = buildTrustedOrigins({
    frontendUrl: APP,
    // One of them listed by hand as well: kept once.
    trustedOrigins: "chrome-extension://abc, capacitor://localhost",
    trustStoreApps: true,
    isProduction: true,
  });
  assert.equal(origins[0], APP);
  assert.ok(origins.includes("chrome-extension://abc"));
  for (const origin of STORE_APP_ORIGINS) assert.ok(origins.includes(origin));
  assert.equal(
    origins.filter((origin) => origin === "capacitor://localhost").length,
    1,
  );
});

test("the phone apps' two document origins are what the store list trusts", () => {
  assert.ok(STORE_APP_ORIGINS.includes("capacitor://localhost"));
  assert.ok(STORE_APP_ORIGINS.includes("https://localhost"));
  assert.ok(
    STORE_APP_ORIGINS.includes(`chrome-extension://${STORE_EXTENSION_ID}`),
  );
});

test("the pinned store extension id is the one Chrome derives from the key", () => {
  // Chrome: SHA-256 of the public key's DER bytes, first 32 hex digits mapped
  // onto a-p. A key rotated without the id (or the reverse) would ship a
  // self-host default that trusts an extension nobody can install.
  const derived = [
    ...createHash("sha256")
      .update(Buffer.from(STORE_EXTENSION_KEY, "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");
  assert.equal(derived, STORE_EXTENSION_ID);
});
