/**
 * Calendar arithmetic in an explicit IANA time zone.
 *
 * Every instant this app stores is absolute (a UTC millisecond), so a duration
 * is always real elapsed time no matter which device measured it. What is NOT
 * absolute is which *calendar day* an instant belongs to: 00:30 in Berlin is
 * 23:30 the previous day in UTC.
 *
 * The reporting code used to answer that question with the host's own local
 * time — meaning the SERVER's zone, which on a deployment is usually UTC. A
 * user in Berlin tracking after midnight had that time filed under the previous
 * day in every report, while the tracker list (grouped in the browser) filed it
 * under the right one. The two screens disagreed about the same entry.
 *
 * These helpers take the zone as an argument so the answer never depends on
 * where the code happens to run.
 */

/** A calendar date, "YYYY-MM-DD". Never an instant. */
export type DayKey = string;

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;

/**
 * `true` when the runtime accepts this zone. Intl throws a RangeError for an
 * unknown identifier, and a bad zone from a client must not take a report down.
 */
export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** The given zone if usable, else UTC. */
export const resolveTimeZone = (timeZone: string | null | undefined): string =>
  timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = partsFormatter.get(timeZone);
  if (cached) return cached;
  // en-CA renders dates as YYYY-MM-DD, which is the key format directly.
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  partsFormatter.set(timeZone, created);
  return created;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const zonedParts = (ms: number, timeZone: string): ZonedParts => {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  // Some engines render midnight as hour 24 rather than 0.
  const hour = read("hour") % 24;

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
};

/** Milliseconds the zone is ahead of UTC at this instant. */
const zoneOffsetMs = (ms: number, timeZone: string): number => {
  const p = zonedParts(ms, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Discard the sub-second remainder so the offset is a whole number of seconds.
  return asIfUtc - Math.floor(ms / 1000) * 1000;
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** The calendar day an instant falls on, in `timeZone`. */
export const dayKeyInZone = (ms: number, timeZone: string): DayKey => {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** Split a key into its numeric parts. */
const keyParts = (key: DayKey): { y: number; m: number; d: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
};

/** A wall-clock reading, as a person would write it on a clock and calendar. */
export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
};

/**
 * The instant at which a wall-clock reading occurs in `timeZone`.
 *
 * This is the inverse of reading a clock: given "21 Aug 2026, 23:30 in Berlin",
 * it returns the absolute millisecond that names.
 *
 * Resolved in two passes: guess using the offset at the naive UTC instant, then
 * re-read the offset at the guessed instant. The second pass is what makes DST
 * transitions come out right, since the offset before and after a shift differ.
 * A wall-clock time skipped by a spring-forward lands on the first instant that
 * does exist; an ambiguous time in a fall-back hour resolves to one of the two,
 * which is the ordinary convention.
 */
export const zonedWallClockToMs = (
  clock: WallClock,
  timeZone: string
): number => {
  const naiveUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour ?? 0,
    clock.minute ?? 0,
    clock.second ?? 0
  );
  const firstGuess = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  return naiveUtc - zoneOffsetMs(firstGuess, timeZone);
};

/**
 * Day starts already resolved, keyed by zone and day. `zonedDayStartMs` is a
 * pure function of the two and costs two `Intl` reads, while a report over a
 * long range asks for the same few thousand days once per entry. Emptied at a
 * bound, so a server reading many zones keeps at most this many.
 */
const dayStarts = new Map<string, number>();
const DAY_START_CACHE_LIMIT = 20_000;

/** The instant at which that calendar day begins in `timeZone`. */
export const zonedDayStartMs = (key: DayKey, timeZone: string): number => {
  const cacheKey = `${timeZone} ${key}`;
  const cached = dayStarts.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts = keyParts(key);
  if (!parts) return Number.NaN;
  const start = zonedWallClockToMs({ year: parts.y, month: parts.m, day: parts.d }, timeZone);
  if (dayStarts.size >= DAY_START_CACHE_LIMIT) dayStarts.clear();
  dayStarts.set(cacheKey, start);
  return start;
};

/** The wall-clock reading an instant shows on a clock in `timeZone`. */
export const wallClockInZone = (ms: number, timeZone: string): Required<WallClock> => {
  const p = zonedParts(ms, timeZone);
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  };
};

/**
 * Short human name for a zone: "Europe/Berlin" -> "Berlin".
 *
 * Used to caption a time that was recorded somewhere else, so "23:30 Berlin"
 * reads the way a person would say it.
 */
export const zoneLabel = (timeZone: string): string => {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
};

/** True when two zone identifiers name the same offset rules right now. */
export const isSameZone = (
  a: string | null | undefined,
  b: string | null | undefined,
  atMs: number = 0
): boolean => {
  const left = resolveTimeZone(a);
  const right = resolveTimeZone(b);
  if (left === right) return true;
  // Different identifiers can still be the same clock (Europe/Berlin vs
  // Europe/Vienna). What matters for display is whether the reading differs.
  return zoneOffsetMs(atMs, left) === zoneOffsetMs(atMs, right);
};

/** Calendar-day arithmetic. Independent of any zone — keys are just dates. */
export const addDaysToKey = (key: DayKey, days: number): DayKey => {
  const parts = keyParts(key);
  if (!parts) return key;
  const moved = new Date(Date.UTC(parts.y, parts.m - 1, parts.d) + days * MS_PER_DAY);
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(
    moved.getUTCDate()
  )}`;
};

/** Day of the week for a key, 0 = Sunday. */
export const weekdayOfKey = (key: DayKey): number => {
  const parts = keyParts(key);
  if (!parts) return 0;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
};

/** The key of the week's first day, honouring `weekStartsOn` (0=Sun, 1=Mon). */
export const weekStartKey = (key: DayKey, weekStartsOn: 0 | 1): DayKey => {
  const shift = (weekdayOfKey(key) - weekStartsOn + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return addDaysToKey(key, -shift);
};

/** "YYYY-MM" for a key. */
export const monthKeyOf = (key: DayKey): string => key.slice(0, 7);

/** Every key from `fromKey` to `toKey` inclusive, ascending. */
export const dayKeysBetween = (fromKey: DayKey, toKey: DayKey): DayKey[] => {
  const keys: DayKey[] = [];
  let cursor = fromKey;
  // Bounded so a malformed key can never spin here.
  for (let guard = 0; guard < 4000 && cursor <= toKey; guard += 1) {
    keys.push(cursor);
    cursor = addDaysToKey(cursor, 1);
  }
  return keys;
};

/**
 * Split an interval into per-calendar-day slices in `timeZone`.
 *
 * Seconds are measured between instants, so a slice spanning a DST shift
 * reports the time that actually elapsed — a "23-hour day" is 23 hours, not 24.
 */
export const splitIntervalByZonedDay = (
  startMs: number,
  endMs: number,
  timeZone: string
): { date: DayKey; seconds: number }[] => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  if (endMs <= startMs) return [];

  const slices: { date: DayKey; seconds: number }[] = [];
  let cursor = startMs;

  for (let guard = 0; guard < 400 && cursor < endMs; guard += 1) {
    const key = dayKeyInZone(cursor, timeZone);
    const nextDayStart = zonedDayStartMs(addDaysToKey(key, 1), timeZone);
    // Guard against a zone where the next boundary fails to advance.
    const boundary = nextDayStart > cursor ? nextDayStart : cursor + MS_PER_DAY;
    const sliceEnd = Math.min(boundary, endMs);

    slices.push({
      date: key,
      seconds: Math.max(0, Math.round((sliceEnd - cursor) / 1000)),
    });
    cursor = sliceEnd;
  }

  return slices;
};

// ── clock reading and writing in an explicit zone ────────────────────

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Render an instant as the clock time it showed in `timeZone`.
 *
 * An entry recorded at 23:30 in Berlin reads "23:30" here no matter where it is
 * being viewed from, which is the point: the time you wrote down is the time
 * you see back.
 */
export const formatClockInZone = (
  iso: string,
  timeZone: string,
  format: "12h" | "24h" = "24h"
): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";

  const clock = wallClockInZone(ms, resolveTimeZone(timeZone));
  if (format === "24h") return `${pad2(clock.hour)}:${pad2(clock.minute)}`;

  const suffix = clock.hour < 12 ? "am" : "pm";
  const hour12 = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  return `${hour12}:${pad2(clock.minute)} ${suffix}`;
};

/**
 * Parse a clock time typed by a person and anchor it to the calendar day that
 * `anchorIso` falls on IN `timeZone`.
 *
 * This is what stops an entry drifting when it is edited from somewhere else.
 * Typing "23:30" on an entry recorded in Berlin means 23:30 Berlin, even if the
 * person editing is in Tokyo — otherwise the same keystrokes would silently
 * move the entry by the offset between the two zones.
 *
 * Returns an ISO instant, or null when the input is not a time.
 */
export const parseTimeOfDayInZone = (
  raw: string,
  anchorIso: string,
  timeZone: string
): string | null => {
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return null;

  const zone = resolveTimeZone(timeZone);
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

  const day = wallClockInZone(anchorMs, zone);
  return new Date(
    zonedWallClockToMs(
      { year: day.year, month: day.month, day: day.day, hour: hours, minute: minutes, second: secs },
      zone
    )
  ).toISOString();
};

/** Re-anchor an instant onto a different calendar day, keeping its clock time in `timeZone`. */
export const withDayInZone = (
  iso: string,
  dayKey: DayKey,
  timeZone: string
): string => {
  const ms = Date.parse(iso);
  const parts = keyParts(dayKey);
  if (Number.isNaN(ms) || !parts) return iso;

  const zone = resolveTimeZone(timeZone);
  const clock = wallClockInZone(ms, zone);
  return new Date(
    zonedWallClockToMs(
      {
        year: parts.y,
        month: parts.m,
        day: parts.d,
        hour: clock.hour,
        minute: clock.minute,
        second: clock.second,
      },
      zone
    )
  ).toISOString();
};

/** True when start and end fall on different calendar days in `timeZone`. */
export const spansDayBoundaryInZone = (
  startIso: string,
  endIso: string | null,
  timeZone: string
): boolean => {
  if (endIso === null) return false;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;

  const zone = resolveTimeZone(timeZone);
  return dayKeyInZone(startMs, zone) !== dayKeyInZone(endMs, zone);
};
