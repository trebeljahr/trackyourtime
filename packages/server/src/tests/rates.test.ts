import assert from "node:assert/strict";
import test from "node:test";
// Subpath import: a bare named import from "@starter/shared" throws under tsx.
// See the note in duration.test.ts.
import {
  entryAmount,
  projectBillableByDefault,
  resolveHourlyRate,
  sumAmounts,
} from "@starter/shared/rates";

// ── resolveHourlyRate ────────────────────────────────────────────────

test("resolveHourlyRate prefers the project rate over the workspace default", () => {
  assert.equal(
    resolveHourlyRate({ billable: true, projectRate: 90, defaultRate: 60 }),
    90
  );
});

test("resolveHourlyRate falls back to the workspace default", () => {
  assert.equal(
    resolveHourlyRate({ billable: true, projectRate: null, defaultRate: 60 }),
    60
  );
  assert.equal(
    resolveHourlyRate({ billable: true, projectRate: undefined, defaultRate: 60 }),
    60
  );
});

test("resolveHourlyRate never snapshots a rate for a non-billable entry", () => {
  assert.equal(
    resolveHourlyRate({ billable: false, projectRate: 90, defaultRate: 60 }),
    null
  );
  assert.equal(
    resolveHourlyRate({ billable: false, projectRate: null, defaultRate: 60 }),
    null
  );
});

test("resolveHourlyRate returns null when neither rate is usable", () => {
  assert.equal(
    resolveHourlyRate({ billable: true, projectRate: null, defaultRate: null }),
    null
  );
  assert.equal(
    resolveHourlyRate({
      billable: true,
      projectRate: undefined,
      defaultRate: undefined,
    }),
    null
  );
  assert.equal(
    resolveHourlyRate({
      billable: true,
      projectRate: Number.NaN,
      defaultRate: Number.POSITIVE_INFINITY,
    }),
    null
  );
});

test("resolveHourlyRate treats an explicit zero project rate as a real rate", () => {
  // A project deliberately set to 0/h must not silently inherit the default.
  assert.equal(
    resolveHourlyRate({ billable: true, projectRate: 0, defaultRate: 60 }),
    0
  );
});

// ── entryAmount ──────────────────────────────────────────────────────

test("entryAmount converts seconds to money at the snapshotted rate", () => {
  assert.equal(entryAmount(3600, 60), 60);
  assert.equal(entryAmount(1800, 60), 30);
  assert.equal(entryAmount(900, 60), 15);
  assert.equal(entryAmount(5400, 42.5), 63.75);
});

test("entryAmount rounds to two decimals", () => {
  assert.equal(entryAmount(3600, 33.333), 33.33);
  assert.equal(entryAmount(1800, 33.333), 16.67);
  assert.equal(entryAmount(1, 100), 0.03);
  assert.equal(entryAmount(60, 0.1), 0);
});

test("entryAmount is zero without a rate or without time", () => {
  assert.equal(entryAmount(3600, null), 0);
  assert.equal(entryAmount(0, 60), 0);
  assert.equal(entryAmount(-3600, 60), 0);
  assert.equal(entryAmount(Number.NaN, 60), 0);
  assert.equal(entryAmount(3600, Number.NaN), 0);
  assert.equal(entryAmount(3600, Number.POSITIVE_INFINITY), 0);
});

// ── sumAmounts ───────────────────────────────────────────────────────

test("sumAmounts adds money without float drift", () => {
  assert.equal(sumAmounts([0.1, 0.2]), 0.3);
  assert.equal(sumAmounts([]), 0);
  assert.equal(sumAmounts([1.005, 2.005]), 3.01);
  assert.equal(sumAmounts(Array.from({ length: 10 }, () => 0.1)), 1);
});

test("sumAmounts matches the sum of per-entry amounts", () => {
  const seconds = [1234, 4321, 999, 60];
  const rate = 33.333;
  const amounts = seconds.map((value) => entryAmount(value, rate));
  assert.equal(
    sumAmounts(amounts),
    Math.round(amounts.reduce((total, amount) => total + amount * 100, 0)) / 100
  );
});

// ── projectBillableByDefault ─────────────────────────────────────────

test("projectBillableByDefault needs the flag AND a rate above 0", () => {
  assert.equal(
    projectBillableByDefault({ billableDefault: true, hourlyRate: 90 }, 0),
    true
  );
  assert.equal(
    projectBillableByDefault({ billableDefault: true, hourlyRate: null }, 60),
    true
  );
  assert.equal(
    projectBillableByDefault({ billableDefault: false, hourlyRate: 90 }, 60),
    false
  );
});

test("projectBillableByDefault: a project billing at 0 is not billable", () => {
  // Its own rate is 0, whatever the workspace default.
  assert.equal(
    projectBillableByDefault({ billableDefault: true, hourlyRate: 0 }, 60),
    false
  );
  // No rate of its own, and the workspace default is 0 (a fresh workspace).
  assert.equal(
    projectBillableByDefault({ billableDefault: true, hourlyRate: null }, 0),
    false
  );
  assert.equal(
    projectBillableByDefault({ billableDefault: true, hourlyRate: undefined }, null),
    false
  );
});
