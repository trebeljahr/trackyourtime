/**
 * Every date, duration, number and name the popup prints in a reader's
 * language, through `Intl`.
 *
 * The same rules as the web client's `i18n/format.ts`, reduced to what a 380px
 * popup shows: the catalog is per language and formatting is per region, so
 * the device's own tag is used whenever its language matches the rendered one
 * (an English reader in London keeps "Fri 5 Sep"), and the bare language
 * otherwise. English durations stay byte-identical to `@starter/shared`'s
 * locale-free output.
 *
 * Never for anything a machine reads back — the popup sends ISO instants and
 * plain numbers to the worker, and none of those pass through here.
 */
import {
  formatDuration,
  formatDurationShort,
  type DurationFormat,
  type Locale,
} from "@starter/shared";

/** The BCP 47 tag `Intl` should format with for a rendered locale. */
export const intlLocale = (locale: Locale): string => {
  if (typeof navigator === "undefined") return locale;
  const tags =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const tag of tags) {
    if (typeof tag === "string" && tag.toLowerCase().split(/[-_]/)[0] === locale) {
      try {
        return Intl.getCanonicalLocales(tag)[0] ?? locale;
      } catch {
        return locale;
      }
    }
  }
  return locale;
};

/**
 * "1:30:00" or "1.50 h" / "1,50 h". English is the shared helper's own
 * locale-free output, so nothing about the English popup moves; German gets
 * its decimal comma and a no-break space. Both parse back through
 * `parseDurationInput`.
 */
export const formatDurationFor = (
  seconds: number,
  locale: Locale,
  durationFormat: DurationFormat = "hms",
): string =>
  locale === "en"
    ? formatDuration(seconds, durationFormat)
    : formatDuration(seconds, durationFormat, intlLocale(locale));

/**
 * An idle span in whole minutes: "42m", "1h", "1h 5m" / "42 min", "1 h",
 * "1 h 5 min".
 *
 * Minutes at the finest, like core's `formatIdleSpan`: an idle threshold is
 * minutes at the shortest, and "37s" would describe a rounding artefact.
 */
export const formatIdleSpanFor = (idleSec: number, locale: Locale): string => {
  const minutes = Math.max(0, Math.round(idleSec / 60));
  const tag = locale === "en" ? undefined : intlLocale(locale);
  if (minutes === 0 || minutes % 60 !== 0) return formatDurationShort(minutes * 60, tag);
  // A whole number of hours: the shared helper would print "1h 0m".
  const hours = minutes / 60;
  return tag === undefined ? `${hours}h` : `${hours} h`;
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * "Fri 5 Sep" / "Fr., 5. Sept." for a calendar day key ("2026-09-05").
 *
 * Rendered in UTC on purpose: the key already names a day in the entry's own
 * zone, and letting the device's offset reinterpret it is how a date slips.
 */
export const formatDayKey = (dayKey: string, locale: Locale): string => {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  const tag = intlLocale(locale);
  let format = dateFormats.get(tag);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(tag, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    dateFormats.set(tag, format);
  }
  return format.format(new Date(ms));
};

/** A weekday name for 0 = Sunday … 6 = Saturday: "Monday" / "Montag". */
export const formatWeekday = (dayIndex: number, locale: Locale): string => {
  // 2023-01-01 was a Sunday; noon UTC so no zone can move it across midnight.
  const date = new Date(Date.UTC(2023, 0, 1 + (((dayIndex % 7) + 7) % 7), 12));
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "long", timeZone: "UTC" }).format(
    date,
  );
};

/** "3 minutes ago" / "vor 3 Minuten", in the largest unit that fits. */
export const formatRelativePast = (seconds: number, locale: Locale): string => {
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  // Largest unit that fits, walked from the top. Comparing against a multiple
  // of the candidate's own size instead would let "hour" run to 60 hours.
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let divisor = 60;
  for (const [candidate, size] of units) {
    if (seconds < size) continue;
    unit = candidate;
    divisor = size;
    break;
  }
  return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }).format(
    -Math.round(seconds / divisor),
    unit,
  );
};

/** "Euro" / "Euro", "US Dollar" / "US-Dollar"; the code itself when `Intl` has no name. */
export const currencyName = (code: string, locale: Locale): string => {
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
};
