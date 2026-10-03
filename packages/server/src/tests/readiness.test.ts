import assert from "node:assert/strict";
import test from "node:test";
import { readiness, setDraining } from "../readiness.js";

test("readiness refuses broken dependencies and distinguishes single-process mode", () => {
  assert.deepEqual(readiness(false, true, true), { ready: false, rollingReady: false });
  assert.deepEqual(readiness(true, true, false), { ready: false, rollingReady: false });
  assert.deepEqual(readiness(true, false, false), { ready: true, rollingReady: false });
  assert.deepEqual(readiness(true, true, true), { ready: true, rollingReady: true });
  setDraining();
  assert.deepEqual(readiness(true, true, true), { ready: false, rollingReady: false });
});
