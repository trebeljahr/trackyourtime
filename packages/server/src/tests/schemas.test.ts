import assert from "node:assert/strict";
import test from "node:test";
// Subpath import: a bare named import from "@starter/shared" throws under tsx.
// See the note in duration.test.ts.
import {
  createEntrySchema,
  createProjectSchema,
  entryListSchema,
  entrySourceSchema,
  hexColorSchema,
  hourlyRateSchema,
  isoDateOrDateTimeSchema,
  isoDateTimeSchema,
  maxDurationSettingsSchema,
  resolveRunawaySchema,
  startTimerSchema,
  stopTimerSchema,
  updateEntrySchema,
  updateSettingsSchema,
} from "@starter/shared/schemas";

/** `true` when the value passes the schema. */
const accepts = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown
): boolean => schema.safeParse(value).success;

// ── primitives ───────────────────────────────────────────────────────

test("hexColorSchema takes 6-digit hex colors only", () => {
  assert.ok(accepts(hexColorSchema, "#4f46e5"));
  assert.ok(accepts(hexColorSchema, "#FFFFFF"));
  assert.ok(!accepts(hexColorSchema, "4f46e5"), "the # is required");
  assert.ok(!accepts(hexColorSchema, "#fff"), "shorthand is not accepted");
  assert.ok(!accepts(hexColorSchema, "#12345g"));
  assert.ok(!accepts(hexColorSchema, "#4f46e55"));
  assert.ok(!accepts(hexColorSchema, "rebeccapurple"));
});

test("isoDateTimeSchema requires a timezone", () => {
  assert.ok(accepts(isoDateTimeSchema, "2026-08-21T09:15:00Z"));
  assert.ok(accepts(isoDateTimeSchema, "2026-08-21T09:15:00.000Z"));
  assert.ok(accepts(isoDateTimeSchema, "2026-08-21T09:15:00+02:00"));
  assert.ok(
    !accepts(isoDateTimeSchema, "2026-08-21T09:15:00"),
    "a local datetime is ambiguous on the wire"
  );
  assert.ok(!accepts(isoDateTimeSchema, "2026-08-21"));
  assert.ok(!accepts(isoDateTimeSchema, "21/08/2026"));
  assert.ok(!accepts(isoDateTimeSchema, ""));
});

test("isoDateOrDateTimeSchema takes a calendar day or a full timestamp", () => {
  assert.ok(accepts(isoDateOrDateTimeSchema, "2026-08-21"));
  assert.ok(accepts(isoDateOrDateTimeSchema, "2026-08-21T09:15:00Z"));
  assert.ok(!accepts(isoDateOrDateTimeSchema, "2026-8-21"));
  assert.ok(!accepts(isoDateOrDateTimeSchema, "2026-13-01"));
});

test("hourlyRateSchema takes a non-negative rate", () => {
  assert.ok(accepts(hourlyRateSchema, 0));
  assert.ok(accepts(hourlyRateSchema, 99.5));
  assert.ok(!accepts(hourlyRateSchema, -1));
  assert.ok(!accepts(hourlyRateSchema, 1_000_001));
  assert.ok(!accepts(hourlyRateSchema, "60"));
});

test("entrySourceSchema names every first-party client, extension included", () => {
  // The extension used to have to claim "api" to get an entry accepted, which
  // made its rows indistinguishable from third-party callers'. Same reason
  // "import" is its own source: a backfilled entry was never measured by a
  // timer here. Order is part of the assertion so a drifting Mongoose enum
  // shows up here first.
  assert.deepEqual(entrySourceSchema.options, [
    "web",
    "desktop",
    "mobile",
    "extension",
    "api",
    "import",
  ]);
  assert.ok(accepts(entrySourceSchema, "extension"));
  assert.ok(accepts(entrySourceSchema, "import"));
  assert.ok(!accepts(entrySourceSchema, "watch"));
});

// ── timer ────────────────────────────────────────────────────────────

test("startTimerSchema accepts an empty start — the server fills the blanks", () => {
  assert.ok(accepts(startTimerSchema, {}));
  assert.ok(
    accepts(startTimerSchema, {
      description: "Wrote tests",
      projectId: "p1",
      taskId: null,
      billable: true,
      start: "2026-08-21T09:15:00Z",
      source: "desktop",
      originId: "tab-1",
    })
  );
});

test("startTimerSchema rejects unknown sources and oversized fields", () => {
  assert.ok(!accepts(startTimerSchema, { source: "watch" }));
  assert.ok(!accepts(startTimerSchema, { description: "x".repeat(501) }));
  assert.ok(!accepts(startTimerSchema, { originId: "o".repeat(65) }));
  assert.ok(!accepts(startTimerSchema, { projectId: "" }));
  assert.ok(!accepts(startTimerSchema, { start: "2026-08-21" }));
});

test("stopTimerSchema works with no arguments at all", () => {
  assert.ok(accepts(stopTimerSchema, {}));
  assert.ok(accepts(stopTimerSchema, { end: "2026-08-21T10:00:00Z" }));
  assert.ok(!accepts(stopTimerSchema, { id: "" }));
});

// ── manual entries ───────────────────────────────────────────────────

test("createEntrySchema requires both bounds and defaults the description", () => {
  const parsed = createEntrySchema.safeParse({
    start: "2026-08-21T09:00:00Z",
    end: "2026-08-21T10:00:00Z",
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.description, "");

  assert.ok(!accepts(createEntrySchema, { start: "2026-08-21T09:00:00Z" }));
  assert.ok(!accepts(createEntrySchema, { end: "2026-08-21T10:00:00Z" }));
});

test("createEntrySchema refuses an end that is not after the start", () => {
  const sameInstant = {
    start: "2026-08-21T09:00:00Z",
    end: "2026-08-21T09:00:00Z",
  };
  assert.ok(!accepts(createEntrySchema, sameInstant), "zero-length entry");
  assert.ok(
    !accepts(createEntrySchema, {
      start: "2026-08-21T10:00:00Z",
      end: "2026-08-21T09:00:00Z",
    }),
    "backwards entry"
  );

  const result = createEntrySchema.safeParse(sameInstant);
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues[0].path, ["end"]);
});

test("createEntrySchema compares instants, not strings", () => {
  // Same moment expressed in two zones — still zero length, still rejected.
  assert.ok(
    !accepts(createEntrySchema, {
      start: "2026-08-21T09:00:00Z",
      end: "2026-08-21T11:00:00+02:00",
    })
  );
  assert.ok(
    accepts(createEntrySchema, {
      start: "2026-08-21T09:00:00Z",
      end: "2026-08-21T12:00:00+02:00",
    })
  );
});

test("updateEntrySchema allows null end to keep an entry running", () => {
  assert.ok(accepts(updateEntrySchema, { id: "e1", end: null }));
  assert.ok(accepts(updateEntrySchema, { id: "e1", start: "2026-08-21T09:00:00Z" }));
  assert.ok(
    accepts(updateEntrySchema, { id: "e1", end: "2026-08-21T10:00:00Z" }),
    "an end alone is checked against the stored start server-side"
  );
  assert.ok(
    !accepts(updateEntrySchema, {
      id: "e1",
      start: "2026-08-21T10:00:00Z",
      end: "2026-08-21T09:00:00Z",
    })
  );
  assert.ok(!accepts(updateEntrySchema, { end: null }), "the id is required");
});

test("entryListSchema bounds the page size", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  assert.ok(accepts(entryListSchema, range));
  assert.ok(accepts(entryListSchema, { ...range, limit: 500 }));
  assert.ok(!accepts(entryListSchema, { ...range, limit: 501 }));
  assert.ok(!accepts(entryListSchema, { ...range, limit: 0 }));
  assert.ok(!accepts(entryListSchema, { ...range, limit: 10.5 }));
  assert.ok(!accepts(entryListSchema, { to: "2026-08-31" }));
  assert.ok(!accepts(entryListSchema, { ...range, search: "s".repeat(201) }));
});

// ── catalog ──────────────────────────────────────────────────────────

test("createProjectSchema treats client and rate as optional and nullable", () => {
  assert.ok(accepts(createProjectSchema, { name: "trackyourtime" }));
  assert.ok(
    accepts(createProjectSchema, {
      name: "trackyourtime",
      color: "#4f46e5",
      clientId: null,
      billableDefault: false,
      hourlyRate: null,
    })
  );
  assert.ok(!accepts(createProjectSchema, { name: "" }));
  assert.ok(!accepts(createProjectSchema, { name: "x".repeat(121) }));
  assert.ok(!accepts(createProjectSchema, { name: "ok", hourlyRate: -5 }));
});

// ── settings ─────────────────────────────────────────────────────────

test("updateSettingsSchema demands an uppercase ISO 4217 code", () => {
  assert.ok(accepts(updateSettingsSchema, { currency: "EUR" }));
  assert.ok(!accepts(updateSettingsSchema, { currency: "eur" }));
  assert.ok(!accepts(updateSettingsSchema, { currency: "EURO" }));
  assert.ok(!accepts(updateSettingsSchema, { currency: "€" }));
});

test("updateSettingsSchema keeps every field optional", () => {
  assert.ok(accepts(updateSettingsSchema, {}));
  assert.ok(accepts(updateSettingsSchema, { weekStartsOn: 0 }));
  assert.ok(accepts(updateSettingsSchema, { weekStartsOn: 1 }));
  assert.ok(!accepts(updateSettingsSchema, { weekStartsOn: 2 }));
  assert.ok(!accepts(updateSettingsSchema, { timeFormat: "48h" }));
  assert.ok(!accepts(updateSettingsSchema, { durationFormat: "clock" }));
});

test("updateSettingsSchema takes the three theme choices and nothing else", () => {
  // The theme is a stored preference rather than a per-browser one, so a
  // client that invented a fourth name would darken itself and nothing else.
  assert.ok(accepts(updateSettingsSchema, { theme: "light" }));
  assert.ok(accepts(updateSettingsSchema, { theme: "dark" }));
  assert.ok(accepts(updateSettingsSchema, { theme: "system" }));
  assert.ok(!accepts(updateSettingsSchema, { theme: "auto" }));
  assert.ok(!accepts(updateSettingsSchema, { theme: "" }));
});

test("maxDurationSettingsSchema allows 0 as the off switch but nothing below the minimum", () => {
  const valid = { maxHours: 12, behavior: "ask" };
  assert.ok(accepts(maxDurationSettingsSchema, valid));
  // 0 is the documented "off"; anything between 0 and the minimum would be a
  // guard that fires on entries nobody has finished starting yet.
  assert.ok(accepts(maxDurationSettingsSchema, { ...valid, maxHours: 0 }));
  assert.ok(!accepts(maxDurationSettingsSchema, { ...valid, maxHours: -1 }));
  assert.ok(!accepts(maxDurationSettingsSchema, { ...valid, maxHours: 169 }));
  assert.ok(!accepts(maxDurationSettingsSchema, { ...valid, maxHours: 12.5 }));
  assert.ok(!accepts(maxDurationSettingsSchema, { ...valid, behavior: "pause" }));
  assert.ok(accepts(maxDurationSettingsSchema, { ...valid, behavior: "cap" }));
  assert.ok(accepts(maxDurationSettingsSchema, { ...valid, behavior: "stop" }));
});

test("updateSettingsSchema takes a partial maxDuration block", () => {
  assert.ok(accepts(updateSettingsSchema, { maxDuration: { maxHours: 0 } }));
  assert.ok(accepts(updateSettingsSchema, { maxDuration: { behavior: "cap" } }));
  assert.ok(!accepts(updateSettingsSchema, { maxDuration: { behavior: "nope" } }));
});

test("resolveRunawaySchema names every answer and demands an id", () => {
  for (const resolution of ["keep", "cap", "restore", "end-at"]) {
    assert.ok(accepts(resolveRunawaySchema, { id: "e1", resolution }));
  }
  assert.ok(!accepts(resolveRunawaySchema, { id: "e1", resolution: "delete" }));
  assert.ok(!accepts(resolveRunawaySchema, { resolution: "keep" }));
  // An end without a zone is ambiguous by exactly the offset it omits.
  assert.ok(
    accepts(resolveRunawaySchema, {
      id: "e1",
      resolution: "end-at",
      end: "2026-08-28T22:30:00.000Z",
    })
  );
  assert.ok(
    !accepts(resolveRunawaySchema, {
      id: "e1",
      resolution: "end-at",
      end: "2026-08-28T22:30:00",
    })
  );
});
