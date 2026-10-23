/**
 * Turning the strings in somebody else's export into the values this app
 * stores: instants, seconds, booleans, tag lists.
 *
 * Unreadable dates, durations and amounts return null, so one bad row becomes
 * one skipped row with an explanation. Tag limits refuse the whole file rather
 * than silently discarding names the caller expected to restore.
 */
import { ImportFileError, MAX_IMPORT_TAGS, zonedWallClockToMs, type ImportDateOrder } from "@starter/shared";

/** A calendar date with no time of day attached. */
export type CalendarDate = { year: number; month: number; day: number };

/** A time of day, seconds included. */
export type ClockTime = { hour: number; minute: number; second: number };

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** `2026-08-21`, `2026/08/21` — unambiguous, so it needs no date order. */
const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
/** `21/08/2026`, `21.08.2026`, `8/21/26` — order decided per file. */
const SLASHED_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
/** `21 Aug 2026`, `Aug 21, 2026`, `21-Aug-2026`. */
const NAMED_DATE_DMY = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-,\s]+(\d{4})$/;
const NAMED_DATE_MDY = /^([A-Za-z]{3,})[-\s](\d{1,2})[-,\s]+(\d{4})$/;
/** `09:15`, `9:15:30`, `09:15 AM`, `9:15:30 pm`. */
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/;
/** A full ISO instant, with or without an offset. */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

const isBetween = (value: number, low: number, high: number): boolean =>
  Number.isFinite(value) && value >= low && value <= high;

/** Two-digit years: `99` is 1999, `26` is 2026. Same window everyone uses. */
const expandYear = (year: number): number =>
  year >= 100 ? year : year >= 70 ? 1900 + year : 2000 + year;

/** Parse a date-only cell. Returns null when it is not a date at all. */
export function parseCalendarDate(
  value: string,
  order: ImportDateOrder,
): CalendarDate | null {
  const text = value.trim();
  if (!text) return null;

  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return buildDate(Number(y), Number(m), Number(d));
  }

  const slashed = SLASHED_DATE.exec(text);
  if (slashed) {
    const [, a, b, c] = slashed;
    const first = Number(a);
    const second = Number(b);
    const year = expandYear(Number(c));
    // A component over 12 can only be a day, whatever the file's convention
    // says — so an individual row still lands correctly even if the per-file
    // order was decided wrongly.
    if (first > 12) return buildDate(year, second, first);
    if (second > 12) return buildDate(year, first, second);
    return order === "mdy"
      ? buildDate(year, first, second)
      : buildDate(year, second, first);
  }

  const dmy = NAMED_DATE_DMY.exec(text);
  if (dmy) {
    const [, d, name, y] = dmy;
    const month = MONTH_NAMES[(name ?? "").slice(0, 3).toLowerCase()];
    if (month) return buildDate(Number(y), month, Number(d));
  }

  const mdy = NAMED_DATE_MDY.exec(text);
  if (mdy) {
    const [, name, d, y] = mdy;
    const month = MONTH_NAMES[(name ?? "").slice(0, 3).toLowerCase()];
    if (month) return buildDate(Number(y), month, Number(d));
  }

  return null;
}

function buildDate(
  year: number,
  month: number,
  day: number,
): CalendarDate | null {
  if (!isBetween(year, 1970, 2999)) return null;
  if (!isBetween(month, 1, 12)) return null;
  if (!isBetween(day, 1, 31)) return null;
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Parse a time-of-day cell, 12- or 24-hour. */
export function parseClockTime(value: string): ClockTime | null {
  const text = value.trim();
  if (!text) return null;
  const match = CLOCK.exec(text);
  if (!match) return null;

  const [, h, m, s, meridiem] = match;
  let hour = Number(h);
  const minute = Number(m);
  const second = s === undefined ? 0 : Number(s);
  if (!isBetween(minute, 0, 59) || !isBetween(second, 0, 59)) return null;

  if (meridiem) {
    const pm = meridiem.toLowerCase() === "p";
    if (!isBetween(hour, 1, 12)) return null;
    // 12am is 00:xx and 12pm is 12:xx — the one case where the arithmetic is
    // not "add twelve".
    hour = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
  } else if (!isBetween(hour, 0, 23)) {
    return null;
  }

  return { hour, minute, second };
}

/**
 * Parse a cell holding a full date AND time.
 *
 * A cell carrying its own offset (`…Z`, `…+02:00`) is absolute and is taken at
 * face value. One without is a WALL-CLOCK reading, and is resolved in the
 * import's chosen zone — the whole reason that zone is asked for.
 */
export function parseInstant(
  value: string,
  order: ImportDateOrder,
  timeZone: string,
): number | null {
  const text = value.trim();
  if (!text) return null;

  const iso = ISO_INSTANT.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, offset] = iso;
    const date = buildDate(Number(y), Number(mo), Number(d));
    const clock = { hour: Number(h), minute: Number(mi), second: s === undefined ? 0 : Number(s) };
    if (!date || !isBetween(clock.hour, 0, 23) ||
      !isBetween(clock.minute, 0, 59) || !isBetween(clock.second, 0, 59)) return null;
    if (offset) {
      const parsed = Date.parse(text.replace(" ", "T"));
      return Number.isNaN(parsed) ? null : parsed;
    }
    return combine(date, clock, timeZone);
  }

  // Anything else: split on the first space and read the halves separately, so
  // `21/08/2026 09:15` and `Aug 21, 2026 9:15 AM` both work.
  const split = splitDateAndTime(text);
  if (!split) return null;
  const date = parseCalendarDate(split.date, order);
  if (!date) return null;
  const clock = parseClockTime(split.time);
  if (!clock) return null;
  return combine(date, clock, timeZone);
}

/**
 * Split `"Aug 21, 2026 9:15 AM"` into its date and time halves.
 *
 * Done from the RIGHT: the time is the last one or two whitespace-separated
 * pieces (the second only when it is a meridiem), which is the only rule that
 * survives month names containing spaces and commas.
 */
function splitDateAndTime(
  text: string,
): { date: string; time: string } | null {
  const parts = text.split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1] ?? "";
  if (/^[AaPp]\.?[Mm]?\.?$/.test(last) && parts.length >= 3) {
    return {
      date: parts.slice(0, -2).join(" "),
      time: `${parts[parts.length - 2]} ${last}`,
    };
  }
  return { date: parts.slice(0, -1).join(" "), time: last };
}

/** The instant a date plus a clock time names in `timeZone`. */
export const combine = (
  date: CalendarDate,
  clock: ClockTime,
  timeZone: string,
): number | null => {
  try {
    const result = zonedWallClockToMs(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: clock.hour,
        minute: clock.minute,
        second: clock.second,
      },
      timeZone,
    );
    return Number.isFinite(result) ? result : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
};

/** What a temporal cell turned out to be — used to refine column roles. */
export type TemporalKind = "instant" | "date" | "time" | "unknown";

export function classifyTemporal(
  value: string,
  order: ImportDateOrder,
): TemporalKind {
  if (!value.trim()) return "unknown";
  if (parseInstant(value, order, "UTC") !== null) return "instant";
  if (parseCalendarDate(value, order) !== null) return "date";
  if (parseClockTime(value) !== null) return "time";
  return "unknown";
}

/** Unit hint carried by a duration column's header, when it has one. */
export type DurationUnit = "auto" | "hours" | "minutes" | "seconds";

export function durationUnitFromHeader(header: string): DurationUnit {
  const text = header.toLowerCase();
  if (/\bsec(ond)?s?\b|\(s\)/.test(text)) return "seconds";
  if (/\bmin(ute)?s?\b/.test(text)) return "minutes";
  if (/\bh(ours?|rs?)?\b|\(h\)|decimal/.test(text)) return "hours";
  return "auto";
}

/**
 * Read a duration cell as seconds.
 *
 * Three notations are in the wild and all three appear in the SAME file
 * sometimes (`01:30:00` next to `1.5`), so the notation is decided per value:
 *
 *  - clock form (`1:30`, `01:30:00`) is hours:minutes[:seconds], always;
 *  - a decimal (`1.5`, `1,5`) is hours, unless the header named another unit;
 *  - a bare integer follows the header's unit, and with no header hint is read
 *    as hours up to 24 and as seconds above it — `8` is a working day, `28800`
 *    is the same day counted in seconds, and no real entry is 28800 hours.
 */
export function parseDurationSec(
  value: string,
  unit: DurationUnit = "auto",
): number | null {
  const text = value.trim();
  if (!text) return null;

  const clock = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (clock) {
    const [, sign, h, m, s] = clock;
    const seconds =
      Number(h) * 3600 + Number(m) * 60 + (s === undefined ? 0 : Number(s));
    return Number.isFinite(seconds) ? (sign === "-" ? -seconds : seconds) : null;
  }

  // `1,5` is `1.5` wherever the comma is the decimal separator. Safe to swap
  // because a thousands separator cannot appear in a duration this small.
  const numeric = Number(text.replace(",", "."));
  if (!Number.isFinite(numeric)) return null;

  const effective =
    unit !== "auto"
      ? unit
      : Number.isInteger(numeric) && Math.abs(numeric) > 24
        ? "seconds"
        : "hours";

  const seconds = Math.round(numeric * (effective === "seconds" ? 1 : effective === "minutes" ? 60 : 3600));
  return Number.isFinite(seconds) ? seconds : null;
}

const TRUE_WORDS = new Set([
  "true", "yes", "y", "1", "billable", "ja", "oui", "si", "x",
]);
const FALSE_WORDS = new Set([
  "false", "no", "n", "0", "non-billable", "nonbillable", "nein", "non",
]);

/** `null` when the cell says nothing either way — the caller's default wins. */
export function parseBoolean(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/**
 * Split a tag cell. Comma, semicolon and pipe all separate in the wild, and a
 * tag containing a comma is unrecoverable from a comma-joined cell anyway.
 */
export function parseTagNames(value: string): string[] {
  const names = new Set<string>();
  for (const part of value.split(/[,;|]/)) {
    const name = part.trim();
    if (name === "") continue;
    if (name.length > 60) throw new ImportFileError("An imported tag name can have at most 60 characters.");
    names.add(name);
    if (names.size > MAX_IMPORT_TAGS) {
      throw new ImportFileError(`An imported entry can have at most ${MAX_IMPORT_TAGS} tags.`);
    }
  }
  return [...names];
}

/** A money cell: strips currency symbols and thousands separators. */
export function parseAmount(value: string): number | null {
  const text = value.trim().replace(/[^\d.,-]/g, "");
  if (!text) return null;
  // `1.234,56` (dot thousands) vs `1,234.56` (comma thousands): whichever
  // separator comes LAST is the decimal one.
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const normalized =
    lastComma > lastDot
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide a file's day/month order from every slashed date in it.
 *
 * One value with a first component over 12 proves day-first; one with a second
 * component over 12 proves month-first. Both together mean the file is
 * internally inconsistent, and day-first wins only because it is the more
 * common export convention outside the US — the caller is told it was
 * ambiguous either way so the user can say otherwise.
 */
export function detectDateOrder(values: readonly string[]): {
  order: ImportDateOrder;
  ambiguous: boolean;
} {
  let dayFirst = 0;
  let monthFirst = 0;
  let slashed = 0;
  let isoLike = 0;

  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const head = text.split(/\s+/)[0] ?? "";
    if (ISO_DATE.test(head) || ISO_INSTANT.test(text)) {
      isoLike += 1;
      continue;
    }
    const match = SLASHED_DATE.exec(head);
    if (!match) continue;
    slashed += 1;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12) dayFirst += 1;
    else if (second > 12) monthFirst += 1;
  }

  if (slashed === 0) {
    return { order: "ymd", ambiguous: isoLike === 0 };
  }
  if (dayFirst > 0 && monthFirst === 0) return { order: "dmy", ambiguous: false };
  if (monthFirst > 0 && dayFirst === 0) return { order: "mdy", ambiguous: false };
  return { order: "dmy", ambiguous: true };
}
