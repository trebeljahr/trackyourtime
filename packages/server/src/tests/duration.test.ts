import assert from "node:assert/strict";
import test from "node:test";
// NOTE: imported from the "@starter/shared/duration" subpath rather than the
// package root on purpose — a bare named import from "@starter/shared" throws
// "does not provide an export named ..." under tsx. See the bug reported with
// these tests; switch back to the root specifier once that is fixed.
import {
  entryDurationSec,
  formatDuration,
  formatDurationShort,
  parseDurationInput,
  parseTimeOfDay,
  splitEntryByDay,
  toLocalDateKey,
  type DurationEntry,
  rollEndAfterStart,
  spansLocalDayBoundary,
} from "@starter/shared/duration";

const HOUR = 3600;
const MINUTE = 60;

/** Local wall-clock time as the ISO string the wire carries. */
const localIso = (
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0
): string => new Date(year, month, day, hours, minutes, seconds, 0).toISOString();

const entry = (
  start: string,
  end: string | null,
  durationSec = 0
): DurationEntry => ({ start, end, durationSec });

// ── parseDurationInput ───────────────────────────────────────────────

test("parseDurationInput reads h:mm and h:mm:ss", () => {
  assert.equal(parseDurationInput("1:30"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("0:05"), 5 * MINUTE);
  assert.equal(parseDurationInput("1:30:00"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("1:30:15"), HOUR + 30 * MINUTE + 15);
  assert.equal(parseDurationInput("12:00"), 12 * HOUR);
});

test("parseDurationInput treats a bare number as minutes", () => {
  assert.equal(parseDurationInput("90"), 90 * MINUTE);
  assert.equal(parseDurationInput("1.5"), 90);
  assert.equal(parseDurationInput("1,5"), 90);
  assert.equal(parseDurationInput("0"), 0);
});

test("parseDurationInput reads single-letter unit forms, singly and combined", () => {
  assert.equal(parseDurationInput("1.5h"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("1,5h"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("2h"), 2 * HOUR);
  assert.equal(parseDurationInput("90m"), 90 * MINUTE);
  assert.equal(parseDurationInput("45s"), 45);
  assert.equal(parseDurationInput("1h30m"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("1h 30m 15s"), HOUR + 30 * MINUTE + 15);
  assert.equal(parseDurationInput("2h5m"), 2 * HOUR + 5 * MINUTE);
});

/**
 * KNOWN BUG (fails today): the unit alternation in `parseDurationInput` is
 * ordered shortest-first — `(h|hr|hrs|hour|hours|m|min|...)` — so "h" wins on
 * "2hrs", the trailing "rs" is left unconsumed and the whole input is
 * rejected. Every multi-character spelling the pattern advertises is
 * unreachable. Fix: order the alternation longest-first
 * (`hours|hour|hrs|hr|h|…`).
 */
test("parseDurationInput reads the long unit spellings its pattern advertises", () => {
  assert.equal(parseDurationInput("2hrs"), 2 * HOUR);
  assert.equal(parseDurationInput("2hours"), 2 * HOUR);
  assert.equal(parseDurationInput("90min"), 90 * MINUTE);
  assert.equal(parseDurationInput("90minutes"), 90 * MINUTE);
  assert.equal(parseDurationInput("45sec"), 45);
  assert.equal(parseDurationInput("45seconds"), 45);
  assert.equal(parseDurationInput("2 hours 5 minutes"), 2 * HOUR + 5 * MINUTE);
});

test("parseDurationInput accepts the 1h30 shorthand", () => {
  assert.equal(parseDurationInput("1h30"), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("1h 30"), HOUR + 30 * MINUTE);
});

test("parseDurationInput is case and whitespace insensitive", () => {
  assert.equal(parseDurationInput("  1H 30M  "), HOUR + 30 * MINUTE);
  assert.equal(parseDurationInput("1:30 "), HOUR + 30 * MINUTE);
});

test("parseDurationInput rejects input it cannot read", () => {
  assert.equal(parseDurationInput(""), null);
  assert.equal(parseDurationInput("   "), null);
  assert.equal(parseDurationInput("abc"), null);
  assert.equal(parseDurationInput("1x"), null);
  assert.equal(parseDurationInput("1:99"), null, "minutes over 59 are not a time");
  assert.equal(parseDurationInput("1:30:99"), null, "seconds over 59 are not a time");
  assert.equal(parseDurationInput("-5"), null);
  assert.equal(parseDurationInput("1h 30 nonsense"), null);
  assert.equal(parseDurationInput("12:30 pm"), null, "a clock time is not a duration");
});

// ── formatDuration ───────────────────────────────────────────────────

test("formatDuration renders hms with zero-padded parts", () => {
  assert.equal(formatDuration(0), "0:00:00");
  assert.equal(formatDuration(5), "0:00:05");
  assert.equal(formatDuration(65), "0:01:05");
  assert.equal(formatDuration(HOUR + 30 * MINUTE + 15), "1:30:15");
  assert.equal(formatDuration(100 * HOUR), "100:00:00");
});

test("formatDuration renders decimal hours to two places", () => {
  assert.equal(formatDuration(0, "decimal"), "0.00 h");
  assert.equal(formatDuration(HOUR + 30 * MINUTE, "decimal"), "1.50 h");
  assert.equal(formatDuration(5040, "decimal"), "1.40 h");
});

test("formatDuration keeps the sign of negative values", () => {
  assert.equal(formatDuration(-90), "-0:01:30");
  assert.equal(formatDuration(-HOUR, "decimal"), "-1.00 h");
});

test("formatDuration rounds fractional seconds", () => {
  assert.equal(formatDuration(59.6), "0:01:00");
  assert.equal(formatDuration(0.4), "0:00:00");
});

test("formatDurationShort collapses to the largest useful unit", () => {
  assert.equal(formatDurationShort(45), "45s");
  assert.equal(formatDurationShort(90), "1m");
  assert.equal(formatDurationShort(HOUR + 23 * MINUTE), "1h 23m");
  assert.equal(formatDurationShort(2 * HOUR), "2h 0m");
  assert.equal(formatDurationShort(-90), "-1m");
});

// ── entryDurationSec ─────────────────────────────────────────────────

test("entryDurationSec measures a running entry against now", () => {
  const start = localIso(2026, 7, 21, 9, 0, 0);
  const nowMs = Date.parse(start) + 90 * 1000;
  assert.equal(entryDurationSec(entry(start, null), nowMs), 90);
});

test("entryDurationSec never returns a negative for a future start", () => {
  const start = localIso(2026, 7, 21, 9, 0, 0);
  assert.equal(entryDurationSec(entry(start, null), Date.parse(start) - 60_000), 0);
});

test("entryDurationSec prefers the stored durationSec of a finished entry", () => {
  const start = localIso(2026, 7, 21, 9, 0, 0);
  const end = localIso(2026, 7, 21, 10, 0, 0);
  // Stored value wins even when it disagrees with end - start.
  assert.equal(entryDurationSec(entry(start, end, 1234), 0), 1234);
});

test("entryDurationSec falls back to end - start when durationSec is 0", () => {
  const start = localIso(2026, 7, 21, 9, 0, 0);
  const end = localIso(2026, 7, 21, 10, 30, 0);
  assert.equal(entryDurationSec(entry(start, end, 0), 0), 90 * MINUTE);
});

test("entryDurationSec degrades gracefully on unparseable timestamps", () => {
  assert.equal(entryDurationSec(entry("not-a-date", null, 42), Date.now()), 42);
  assert.equal(entryDurationSec(entry("not-a-date", null, -42), Date.now()), 0);
  const start = localIso(2026, 7, 21, 9, 0, 0);
  assert.equal(entryDurationSec(entry(start, "not-a-date", 0), 0), 0);
});

// ── splitEntryByDay ──────────────────────────────────────────────────

test("splitEntryByDay leaves a same-day entry in one bucket", () => {
  const start = localIso(2026, 7, 21, 9, 0, 0);
  const end = localIso(2026, 7, 21, 11, 30, 0);
  assert.deepEqual(splitEntryByDay(entry(start, end, 9000)), [
    { date: "2026-08-21", seconds: 9000 },
  ]);
});

test("splitEntryByDay splits a midnight-crossing entry across both days", () => {
  const start = localIso(2026, 7, 21, 23, 30, 0);
  const end = localIso(2026, 7, 22, 0, 30, 0);
  assert.deepEqual(splitEntryByDay(entry(start, end, HOUR)), [
    { date: "2026-08-21", seconds: 30 * MINUTE },
    { date: "2026-08-22", seconds: 30 * MINUTE },
  ]);
});

test("splitEntryByDay covers every day a multi-day entry touches", () => {
  const start = localIso(2026, 7, 21, 22, 0, 0);
  const end = localIso(2026, 7, 24, 2, 0, 0);
  const buckets = splitEntryByDay(entry(start, end, 0));

  assert.deepEqual(
    buckets.map((bucket) => bucket.date),
    ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"]
  );
  assert.equal(buckets[0].seconds, 2 * HOUR);
  assert.equal(buckets[3].seconds, 2 * HOUR);
});

test("splitEntryByDay slices re-sum to the entry's own total", () => {
  const start = localIso(2026, 7, 21, 22, 0, 0);
  const end = localIso(2026, 7, 24, 2, 0, 0);
  const total = entryDurationSec(entry(start, end, 0), 0);
  const summed = splitEntryByDay(entry(start, end, 0)).reduce(
    (sum, bucket) => sum + bucket.seconds,
    0
  );
  assert.equal(summed, total);
});

test("splitEntryByDay measures a running entry up to now", () => {
  const start = localIso(2026, 7, 21, 23, 0, 0);
  const nowMs = Date.parse(localIso(2026, 7, 22, 1, 0, 0));
  assert.deepEqual(splitEntryByDay(entry(start, null), 1, nowMs), [
    { date: "2026-08-21", seconds: HOUR },
    { date: "2026-08-22", seconds: HOUR },
  ]);
});

test("splitEntryByDay returns nothing for an empty or broken entry", () => {
  assert.deepEqual(splitEntryByDay(entry("not-a-date", null, 60)), []);
  const start = localIso(2026, 7, 21, 9, 0, 0);
  assert.deepEqual(splitEntryByDay(entry(start, start, 0)), []);
});

test("splitEntryByDay ignores weekStartsOn — day buckets are calendar days", () => {
  const start = localIso(2026, 7, 21, 23, 30, 0);
  const end = localIso(2026, 7, 22, 0, 30, 0);
  assert.deepEqual(
    splitEntryByDay(entry(start, end, HOUR), 0),
    splitEntryByDay(entry(start, end, HOUR), 1)
  );
});

// ── date/time helpers ────────────────────────────────────────────────

test("toLocalDateKey formats a local calendar day", () => {
  assert.equal(toLocalDateKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(toLocalDateKey(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

test("parseTimeOfDay anchors a clock time to a local day", () => {
  const iso = parseTimeOfDay("9:15", "2026-08-21");
  assert.ok(iso !== null);
  const parsed = new Date(iso);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 7);
  assert.equal(parsed.getDate(), 21);
  assert.equal(parsed.getHours(), 9);
  assert.equal(parsed.getMinutes(), 15);
});

test("parseTimeOfDay understands am/pm and bare hours", () => {
  const at = (raw: string): number => {
    const iso = parseTimeOfDay(raw, "2026-08-21");
    assert.ok(iso !== null, `expected ${raw} to parse`);
    return new Date(iso).getHours();
  };
  assert.equal(at("9pm"), 21);
  assert.equal(at("12am"), 0);
  assert.equal(at("12pm"), 12);
  assert.equal(at("0915"), 9);
  assert.equal(at("23:45"), 23);
});

test("parseTimeOfDay rejects impossible clock times", () => {
  assert.equal(parseTimeOfDay("", "2026-08-21"), null);
  assert.equal(parseTimeOfDay("25:00", "2026-08-21"), null);
  assert.equal(parseTimeOfDay("9:75", "2026-08-21"), null);
  assert.equal(parseTimeOfDay("13pm", "2026-08-21"), null);
  assert.equal(parseTimeOfDay("noon", "2026-08-21"), null);
  assert.equal(parseTimeOfDay("9:15", "not-a-day"), null);
});

// ── rollEndAfterStart / spansLocalDayBoundary ────────────────────────

test("rollEndAfterStart leaves an end that is already after the start", () => {
  const start = "2026-08-21T09:00:00.000Z";
  const end = "2026-08-21T10:00:00.000Z";
  assert.equal(rollEndAfterStart(start, end), end);
});

test("rollEndAfterStart rolls a midnight-crossing end onto the next day", () => {
  // 23:30 → 00:30 is an hour of work. It used to be clamped to one minute.
  const start = "2026-08-21T23:30:00.000Z";
  const typed = "2026-08-21T00:30:00.000Z";
  const rolled = rollEndAfterStart(start, typed);

  assert.equal(rolled, "2026-08-22T00:30:00.000Z");
  assert.equal((Date.parse(rolled) - Date.parse(start)) / 1000, 3600);
});

test("rollEndAfterStart rolls an end equal to the start", () => {
  const start = "2026-08-21T09:00:00.000Z";
  assert.equal(rollEndAfterStart(start, start), "2026-08-22T09:00:00.000Z");
});

test("rollEndAfterStart gives up rather than inventing a multi-day entry", () => {
  // Two days earlier cannot be reached within the one-day allowance, so the
  // input is returned untouched for the caller to reject.
  const start = "2026-08-21T09:00:00.000Z";
  const end = "2026-08-19T09:00:00.000Z";
  assert.equal(rollEndAfterStart(start, end), end);
});

test("rollEndAfterStart passes through unparseable input", () => {
  assert.equal(rollEndAfterStart("nonsense", "also nonsense"), "also nonsense");
});

test("spansLocalDayBoundary detects an entry that ends on another day", () => {
  const sameDay = new Date(2026, 7, 21, 9, 0);
  const laterSameDay = new Date(2026, 7, 21, 17, 0);
  const nextDay = new Date(2026, 7, 22, 0, 30);

  assert.equal(
    spansLocalDayBoundary(sameDay.toISOString(), laterSameDay.toISOString()),
    false,
  );
  assert.equal(
    spansLocalDayBoundary(sameDay.toISOString(), nextDay.toISOString()),
    true,
  );
  // A running entry has no end and therefore spans nothing yet.
  assert.equal(spansLocalDayBoundary(sameDay.toISOString(), null), false);
});

// ── locale ───────────────────────────────────────────────────────────
//
// The web app prints durations in the reader's language, and a German decimal
// comma is the one character the rest of the system must never be surprised
// by. These pin both halves: the locale-free output every machine reader
// depends on is byte-identical to before, and every localised form parses back.

test("formatDuration without a locale is unchanged (Raycast, CSV, server)", () => {
  assert.equal(formatDuration(5400, "decimal"), "1.50 h");
  assert.equal(formatDurationShort(5400), "1h 30m");
});

test("formatDuration prints a German decimal comma with a no-break space", () => {
  assert.equal(formatDuration(5400, "decimal", "de"), "1,50 h");
  assert.equal(formatDuration(5400, "decimal", "en"), "1.50 h");
  // No grouping: "1.234,50" would put a dot — a decimal point to anybody
  // typing — into a German duration.
  assert.equal(formatDuration(1234.5 * HOUR, "decimal", "de"), "1234,50 h");
  assert.equal(formatDuration(5400, "hms", "de"), "1:30:00");
});

test("formatDurationShort follows the German unit convention", () => {
  assert.equal(formatDurationShort(HOUR + 23 * MINUTE, "de"), "1 h 23 min");
  assert.equal(formatDurationShort(23 * MINUTE, "de-AT"), "23 min");
  assert.equal(formatDurationShort(45, "de"), "45 s");
  assert.equal(formatDurationShort(HOUR + 23 * MINUTE, "en"), "1h 23m");
});

test("every localised duration parses back to the same seconds", () => {
  for (const seconds of [90 * MINUTE, 5040, 45 * MINUTE, 8 * HOUR]) {
    for (const locale of [undefined, "en", "de"]) {
      const decimal = formatDuration(seconds, "decimal", locale);
      const short = formatDurationShort(seconds, locale);
      assert.equal(parseDurationInput(decimal), seconds, `${decimal} (${locale})`);
      assert.equal(parseDurationInput(short), seconds, `${short} (${locale})`);
    }
  }
  assert.equal(parseDurationInput("1,5"), 90);
  assert.equal(parseDurationInput("1.5"), 90);
});
