import type { DurationFormat, TimeEntry, WeekStart } from "./types.js";

/** The subset of a TimeEntry the duration helpers need. */
export type DurationEntry = Pick<TimeEntry, "start" | "end" | "durationSec">;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MS_PER_DAY = 86_400_000;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Live duration of an entry in whole seconds. Running entries (end === null)
 * are measured against `nowMs`; finished entries prefer their stored
 * `durationSec` and fall back to end - start.
 */
export const entryDurationSec = (entry: DurationEntry, nowMs: number): number => {
  const startMs = Date.parse(entry.start);
  if (Number.isNaN(startMs)) return Math.max(0, Math.round(entry.durationSec));

  if (entry.end === null) {
    return Math.max(0, Math.floor((nowMs - startMs) / 1000));
  }

  if (entry.durationSec > 0) return Math.round(entry.durationSec);

  const endMs = Date.parse(entry.end);
  if (Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
};

/** Two-decimal hour formatters per locale — `Intl.NumberFormat` is costly to build. */
const decimalHourFormatters = new Map<string, Intl.NumberFormat>();

const decimalHours = (hours: number, locale: string): string => {
  let formatter = decimalHourFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      // Never "1.234,50 h": a grouping separator in a German duration is a
      // dot, which is exactly the character a person types as a decimal point.
      useGrouping: false,
    });
    decimalHourFormatters.set(locale, formatter);
  }
  return formatter.format(hours);
};

/** No-break space: a unit must never wrap onto the line after its number. */
const NBSP = "\u00a0";

/**
 * "1:23:45" (hms) or "1.40 h" (decimal). Negative values keep their sign.
 *
 * `locale` only changes the decimal form ("1,40 h" for "de", with a no-break
 * space before the unit). Omitting it keeps the exact pre-i18n output — which
 * is what Raycast, the CSV export and every server caller rely on, so never
 * pass a locale into anything a machine reads back.
 */
export const formatDuration = (
  seconds: number,
  format: DurationFormat = "hms",
  locale?: string
): string => {
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? "-" : "";

  if (format === "decimal") {
    return locale === undefined
      ? `${sign}${(total / SECONDS_PER_HOUR).toFixed(2)} h`
      : `${sign}${decimalHours(total / SECONDS_PER_HOUR, locale)}${NBSP}h`;
  }

  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = total % SECONDS_PER_MINUTE;
  return `${sign}${hours}:${pad2(minutes)}:${pad2(secs)}`;
};

/**
 * Compact human form: "1h 23m", "23m", "45s".
 *
 * With a German locale it follows the German convention of spaced SI unit
 * symbols — "1 h 23 min", "23 min", "45 s" — joined by no-break spaces. Without
 * a locale the English form is unchanged (Raycast depends on it).
 */
export const formatDurationShort = (seconds: number, locale?: string): string => {
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? "-" : "";
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);

  if (locale !== undefined && locale.toLowerCase().startsWith("de")) {
    if (hours > 0) return `${sign}${hours}${NBSP}h ${minutes}${NBSP}min`;
    if (minutes > 0) return `${sign}${minutes}${NBSP}min`;
    return `${sign}${total}${NBSP}s`;
  }

  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  if (minutes > 0) return `${sign}${minutes}m`;
  return `${sign}${total}s`;
};

/**
 * Parse a duration the way a time tracker's duration field does.
 *
 * Accepts "1:30" (h:mm), "1:30:00" (h:mm:ss), "1.5h", "90m", "45s",
 * "1h30m", "1h 30m 15s" and a bare number ("90" → 90 minutes).
 * Returns whole seconds, or null when the input makes no sense.
 *
 * Locale-independent on purpose: a comma and a dot are both decimal points
 * ("1,5h" === "1.5h"), and "min" is accepted as a unit, so everything
 * `formatDuration`/`formatDurationShort` print for ANY locale parses back —
 * a German user who edits "1,50 h" in place must not be told it is invalid.
 */
export const parseDurationInput = (raw: string): number | null => {
  const input = raw.trim().toLowerCase();
  if (input === "") return null;

  // h:mm or h:mm:ss
  const colon = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(input);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    const secs = colon[3] === undefined ? 0 : Number(colon[3]);
    return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + secs;
  }

  // bare number → minutes
  const bare = /^\d+(?:[.,]\d+)?$/.exec(input);
  if (bare) {
    return Math.round(Number(input.replace(",", ".")) * SECONDS_PER_MINUTE);
  }

  // "1h30" / "1h 30" is shorthand for "1h30m"
  const shorthand = input.replace(/^(\d+(?:[.,]\d+)?\s*h)\s*(\d{1,2})$/, "$1$2m");

  // unit form: 1h30m, 1.5h, 90m, 45s (units may repeat but must be known)
  // Alternation MUST be ordered longest-first: regex alternation is
  // first-match-wins, so listing "h" before "hrs" would match the "h" of
  // "2hrs", leave "rs" unconsumed and reject the whole input.
  const unitPattern =
    /(\d+(?:[.,]\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
  let matched = "";
  let seconds = 0;
  for (const match of shorthand.matchAll(unitPattern)) {
    matched += match[0];
    const value = Number(match[1].replace(",", "."));
    const unit = match[2];
    if (unit.startsWith("h")) seconds += value * SECONDS_PER_HOUR;
    else if (unit.startsWith("m")) seconds += value * SECONDS_PER_MINUTE;
    else seconds += value;
  }

  // every non-space character must have been consumed by the unit pattern
  if (matched.replace(/\s+/g, "") !== shorthand.replace(/\s+/g, "")) return null;
  if (seconds <= 0 && matched === "") return null;
  return Math.round(seconds);
};

const localDayParts = (dayIso: string): { y: number; m: number; d: number } | null => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso);
  if (dateOnly) {
    return {
      y: Number(dateOnly[1]),
      m: Number(dateOnly[2]) - 1,
      d: Number(dateOnly[3]),
    };
  }
  const parsed = new Date(dayIso);
  if (Number.isNaN(parsed.getTime())) return null;
  return { y: parsed.getFullYear(), m: parsed.getMonth(), d: parsed.getDate() };
};

/**
 * Parse a clock time typed by the user ("9:15", "09:15", "9:15 pm", "9pm",
 * "0915") and anchor it to `dayIso` (a "YYYY-MM-DD" date or any ISO string)
 * in local time. Returns an ISO datetime string, or null when unparseable.
 */
export const parseTimeOfDay = (raw: string, dayIso: string): string | null => {
  const day = localDayParts(dayIso);
  if (day === null) return null;

  const input = raw.trim().toLowerCase().replace(/\./g, "");
  if (input === "") return null;

  const match =
    /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/.exec(input) ??
    /^(\d{2})(\d{2})()\s*(am|pm)?$/.exec(input);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] === undefined || match[2] === "" ? 0 : Number(match[2]);
  const secs = match[3] === undefined || match[3] === "" ? 0 : Number(match[3]);
  const meridiem = match[4];

  if (meridiem === "am") {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
  } else if (meridiem === "pm") {
    if (hours < 1 || hours > 12) return null;
    if (hours !== 12) hours += 12;
  }

  if (hours > 23 || minutes > 59 || secs > 59) return null;

  return new Date(day.y, day.m, day.d, hours, minutes, secs, 0).toISOString();
};

/** Local "YYYY-MM-DD" for a Date. */
export const toLocalDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/**
 * Split an entry across local calendar days so a midnight-crossing entry
 * contributes to both days. Returns one bucket per day it touches, in order.
 *
 * `weekStartsOn` is accepted for call-site symmetry with the other calendar
 * helpers; day bucketing itself does not depend on it.
 */
export const splitEntryByDay = (
  entry: DurationEntry,
  weekStartsOn: WeekStart = 1,
  nowMs: number = Date.now()
): { date: string; seconds: number }[] => {
  void weekStartsOn;

  const startMs = Date.parse(entry.start);
  if (Number.isNaN(startMs)) return [];

  const endMs =
    entry.end === null ? nowMs : Date.parse(entry.end);
  if (Number.isNaN(endMs) || endMs <= startMs) {
    const seconds = entryDurationSec(entry, nowMs);
    return seconds > 0
      ? [{ date: toLocalDateKey(new Date(startMs)), seconds }]
      : [];
  }

  const buckets: { date: string; seconds: number }[] = [];
  let cursor = startMs;
  let guard = 0;

  while (cursor < endMs && guard < 400) {
    guard += 1;
    const cursorDate = new Date(cursor);
    const nextMidnight = new Date(
      cursorDate.getFullYear(),
      cursorDate.getMonth(),
      cursorDate.getDate() + 1,
      0,
      0,
      0,
      0
    ).getTime();
    const sliceEnd = Math.min(nextMidnight, endMs);
    buckets.push({
      date: toLocalDateKey(cursorDate),
      seconds: Math.max(0, Math.round((sliceEnd - cursor) / 1000)),
    });
    // guards against pathological DST math where midnight does not advance
    cursor = sliceEnd > cursor ? sliceEnd : cursor + MS_PER_DAY;
  }

  return buckets;
};

/**
 * Resolve an end that landed on or before its start by rolling it forward a day.
 *
 * A timer running at 23:30 and stopped at 00:30 is an hour of work across
 * midnight. Editing the end to "00:30" used to be clamped to start + 1 minute,
 * silently destroying the entry — the one interpretation the user certainly did
 * not mean. Rolling forward is the reading that matches what they typed.
 *
 * Only ever advances by whole days, and only far enough to clear the start, so
 * an end already after the start is returned untouched.
 */
export const rollEndAfterStart = (
  startIso: string,
  endIso: string,
  maxDays = 1
): string => {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return endIso;
  if (endMs > startMs) return endIso;

  for (let days = 1; days <= maxDays; days += 1) {
    const rolled = endMs + days * MS_PER_DAY;
    if (rolled > startMs) return new Date(rolled).toISOString();
  }
  return endIso;
};

/** True when the two instants fall on different local calendar days. */
export const spansLocalDayBoundary = (
  startIso: string,
  endIso: string | null
): boolean => {
  if (endIso === null) return false;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return toLocalDateKey(start) !== toLocalDateKey(end);
};
