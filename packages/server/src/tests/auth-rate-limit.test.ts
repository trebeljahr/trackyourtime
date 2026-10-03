import assert from "node:assert/strict";
import { test } from "node:test";

import { authRateLimitEnabled } from "../auth/auth-rate-limit.js";

test("Better Auth keeps rate limiting except on the marked E2E loopback API", () => {
  assert.equal(authRateLimitEnabled("http://127.0.0.1:49764", undefined), true);
  assert.equal(authRateLimitEnabled("http://127.0.0.1:49764", "0"), true);
  assert.equal(authRateLimitEnabled("https://api.trackyourtime.dev", "1"), true);
  assert.equal(authRateLimitEnabled("http://localhost:49764", "1"), true);
  assert.equal(authRateLimitEnabled("http://127.0.0.1:49764", "1"), false);
});
