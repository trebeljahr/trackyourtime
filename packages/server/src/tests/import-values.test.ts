import assert from "node:assert/strict";
import test from "node:test";
import {
  detectDateOrder,
  durationUnitFromHeader,
  parseAmount,
  parseBoolean,
  parseCalendarDate,
  parseClockTime,
  parseDurationSec,
  parseInstant,
  parseTagNames,
} from "../services/import/values.js";

test("reads unambiguous dates without needing a day/month order", () => {
  assert.deepEqual(parseCalendarDate("2026-08-21", "mdy"), {
    year: 2026,
    month: 8,
    day: 21,
  });
  assert.deepEqual(parseCalendarDate("2026/08/21", "dmy"), {
    year: 2026,
    month: 8,
    day: 21,
  });
});

test("a slashed date follows the file's order, unless a component settles it", () => {
  assert.deepEqual(parseCalendarDate("03/04/2026", "dmy"), {
    year: 2026,
    month: 4,
    day: 3,
  });
  assert.deepEqual(parseCalendarDate("03/04/2026", "mdy"), {
    year: 2026,
    month: 3,
    day: 4,
  });
  // 21 cannot be a month, so the row lands correctly even under the wrong order.
  assert.deepEqual(parseCalendarDate("21/04/2026", "mdy"), {
    year: 2026,
    month: 4,
    day: 21,
  });
});

test("two-digit years land in the current century", () => {
  assert.deepEqual(parseCalendarDate("21.08.26", "dmy"), {
    year: 2026,
    month: 8,
    day: 21,
  });
  assert.deepEqual(parseCalendarDate("21.08.99", "dmy"), {
    year: 1999,
    month: 8,
    day: 21,
  });
});

test("reads month names in both orders", () => {
  assert.deepEqual(parseCalendarDate("21 Aug 2026", "dmy"), {
    year: 2026,
    month: 8,
    day: 21,
  });
  assert.deepEqual(parseCalendarDate("Aug 21, 2026", "mdy"), {
    year: 2026,
    month: 8,
    day: 21,
  });
});

test("refuses cells that are not dates", () => {
  assert.equal(parseCalendarDate("", "dmy"), null);
  assert.equal(parseCalendarDate("later", "dmy"), null);
  assert.equal(parseCalendarDate("31/31/2026", "dmy"), null);
});

test("reads 12- and 24-hour clock times", () => {
  assert.deepEqual(parseClockTime("09:15"), { hour: 9, minute: 15, second: 0 });
  assert.deepEqual(parseClockTime("9:15:30"), {
    hour: 9,
    minute: 15,
    second: 30,
  });
  assert.deepEqual(parseClockTime("1:05 PM"), {
    hour: 13,
    minute: 5,
    second: 0,
  });
  // Midnight and noon are the two the "add twelve" rule gets wrong.
  assert.deepEqual(parseClockTime("12:30 AM"), {
    hour: 0,
    minute: 30,
    second: 0,
  });
  assert.deepEqual(parseClockTime("12:30 PM"), {
    hour: 12,
    minute: 30,
    second: 0,
  });
  assert.equal(parseClockTime("25:00"), null);
});

test("a cell carrying its own offset is absolute", () => {
  const ms = parseInstant("2026-08-21T09:15:00Z", "ymd", "Asia/Tokyo");
  assert.equal(new Date(ms ?? 0).toISOString(), "2026-08-21T09:15:00.000Z");
});

test("a cell without an offset is a wall clock in the import's zone", () => {
  // 09:15 in Berlin in August is 07:15Z.
  const ms = parseInstant("2026-08-21 09:15:00", "ymd", "Europe/Berlin");
  assert.equal(new Date(ms ?? 0).toISOString(), "2026-08-21T07:15:00.000Z");
});

test("reads a date and a time written in one cell, in either notation", () => {
  const slashed = parseInstant("21/08/2026 09:15", "dmy", "UTC");
  assert.equal(
    new Date(slashed ?? 0).toISOString(),
    "2026-08-21T09:15:00.000Z",
  );
  const named = parseInstant("Aug 21, 2026 9:15 AM", "mdy", "UTC");
  assert.equal(new Date(named ?? 0).toISOString(), "2026-08-21T09:15:00.000Z");
});

test("durations: clock form, decimals and comma decimals", () => {
  assert.equal(parseDurationSec("01:30:00"), 5400);
  assert.equal(parseDurationSec("1:30"), 5400);
  assert.equal(parseDurationSec("1.5"), 5400);
  assert.equal(parseDurationSec("1,5"), 5400);
});

test("a bare integer duration reads as hours up to a day, seconds beyond it", () => {
  assert.equal(parseDurationSec("8"), 8 * 3600);
  assert.equal(parseDurationSec("5400"), 5400);
});

test("a unit named in the header wins over the value's own shape", () => {
  assert.equal(durationUnitFromHeader("Duration (h)"), "hours");
  assert.equal(durationUnitFromHeader("Duration (min)"), "minutes");
  assert.equal(durationUnitFromHeader("Duration (seconds)"), "seconds");
  assert.equal(durationUnitFromHeader("Duration"), "auto");
  assert.equal(parseDurationSec("90", "minutes"), 5400);
  assert.equal(parseDurationSec("5400", "seconds"), 5400);
});

test("billable cells that say nothing stay undecided", () => {
  assert.equal(parseBoolean("Yes"), true);
  assert.equal(parseBoolean("no"), false);
  assert.equal(parseBoolean("1"), true);
  assert.equal(parseBoolean(""), null);
  assert.equal(parseBoolean("maybe"), null);
});

test("tags split on any of the three separators used in the wild", () => {
  assert.deepEqual(parseTagNames("design, deep work"), [
    "design",
    "deep work",
  ]);
  assert.deepEqual(parseTagNames("design|deep work"), ["design", "deep work"]);
  assert.deepEqual(parseTagNames(" ; "), []);
});

test("money cells survive symbols and either thousands convention", () => {
  assert.equal(parseAmount("€ 1.234,56"), 1234.56);
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("90"), 90);
  assert.equal(parseAmount(""), null);
});

test("the day/month order is settled by any value that can only be a day", () => {
  assert.deepEqual(detectDateOrder(["03/04/2026", "21/04/2026"]), {
    order: "dmy",
    ambiguous: false,
  });
  assert.deepEqual(detectDateOrder(["03/04/2026", "04/21/2026"]), {
    order: "mdy",
    ambiguous: false,
  });
});

test("a file where every date could be read both ways says so", () => {
  const { ambiguous } = detectDateOrder(["03/04/2026", "05/06/2026"]);
  assert.equal(ambiguous, true);
});

test("ISO dates are never ambiguous", () => {
  assert.deepEqual(detectDateOrder(["2026-03-04", "2026-05-06"]), {
    order: "ymd",
    ambiguous: false,
  });
});

test("the importer reads a duration the same whatever language printed it", () => {
  // The importer must stay locale-independent: a file exported by a German
  // spreadsheet and one exported by an English one describe the same hours.
  // Nothing in services/import may ever consult the UI locale.
  assert.equal(parseDurationSec("1,50"), parseDurationSec("1.50"));
  assert.equal(parseDurationSec("7,25"), 7.25 * 3600);
});
