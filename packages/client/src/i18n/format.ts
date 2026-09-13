/**
 * Every number, amount, date, time and duration the UI prints, in one place,
 * through `Intl` and the active locale.
 *
 * Pure functions that take the locale as an argument (server-safe, testable),
 * plus `useFormat()` in i18n/use-format.ts which binds them to the rendering
 * locale. `lib/format.ts`'s `useFormatSettings` layers the user's display
 * preferences (12h/24h, hms/decimal, currency) on top of these.
 *
 * NEVER use any of this for text a machine reads back: CSV export, the
 * importer, API payloads, filenames that are parsed later. Those stay in the
 * locale-free forms `@starter/shared` prints without a locale argument — a
 * German decimal comma in a CSV cell is a different number to the next
 * spreadsheet that opens it.
 */
import {
  defaultWeekStartForLocale,
  formatDuration,
  formatDurationShort,
  type DurationFormat,
  type TimeFormat,
  type WeekStart,
} from "@starter/shared";

import type { ClientLocale } from "@/i18n/config";

/**
 * The BCP 47 tag `Intl` should format with.
 *
 * The catalog is per language, formatting is per region: an English reader in
 * London wants "21 Aug" and one in Boston "Aug 21", a German reader in Vienna
 * wants "Jänner". So the device's own tag is used whenever its language matches
 * the rendered one, and the bare language otherwise — a German-language browser
 * reading the English UI gets plain "en", never German dates under English
 * words. The pseudo-locale formats as English.
 */
export const intlLocale = (locale: ClientLocale): string => {
  const language = locale === "pseudo" ? "en" : locale;
  if (typeof navigator === "undefined") return language;
  const tags =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const tag of tags) {
    if (typeof tag === "string" && tag.toLowerCase().split(/[-_]/)[0] === language) {
      try {
        return Intl.getCanonicalLocales(tag)[0] ?? language;
      } catch {
        return language;
      }
    }
  }
  return language;
};

// `Intl.*Format` construction is the expensive part; formatting is cheap.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

const numberFormat = (tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const key = `${tag}|${JSON.stringify(options)}`;
  let formatter = numberFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
};

const dateFormat = (tag: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${tag}|${JSON.stringify(options)}`;
  let formatter = dateFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(tag, options);
    dateFormats.set(key, formatter);
  }
  return formatter;
};

const toDate = (value: Date | string | number): Date | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? // A bare calendar date is a LOCAL day, never UTC midnight.
          new Date(`${value}T00:00:00`)
        : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// ── numbers ──────────────────────────────────────────────────────────

/** "1,234.5" / "1.234,5". */
export const formatNumber = (
  value: number,
  locale: ClientLocale,
  options: Intl.NumberFormatOptions = {},
): string => numberFormat(intlLocale(locale), options).format(Number.isFinite(value) ? value : 0);

/** Fixed fraction digits: "12.50" / "12,50". */
export const formatDecimal = (value: number, locale: ClientLocale, fractionDigits = 2): string =>
  formatNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

/** `ratio` is 0..1: "42%" / "42 %". */
export const formatPercent = (ratio: number, locale: ClientLocale, fractionDigits = 0): string =>
  formatNumber(ratio, locale, { style: "percent", maximumFractionDigits: fractionDigits });

/**
 * "€1,234.50" / "1.234,50 €". An ISO code `Intl` rejects falls back to
 * "1,234.50 XYZ" rather than throwing mid-render.
 */
export const formatMoney = (amount: number, currency: string, locale: ClientLocale): string => {
  const safe = Number.isFinite(amount) ? amount : 0;
  const code = currency.toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return numberFormat(intlLocale(locale), {
        style: "currency",
        currency: code,
        maximumFractionDigits: 2,
      }).format(safe);
    } catch {
      /* fall through */
    }
  }
  return `${formatDecimal(safe, locale)} ${currency}`.trim();
};

// ── dates and times ──────────────────────────────────────────────────

/** Named date styles, so call sites agree on what "short" means. */
export const DATE_STYLES = {
  /** "21/08/2026", "8/21/2026", "21.08.2026" */
  numeric: { day: "2-digit", month: "2-digit", year: "numeric" },
  /** "21 Aug 2026", "Aug 21, 2026", "21. Aug. 2026" */
  medium: { day: "numeric", month: "short", year: "numeric" },
  /** "21 August 2026", "21. August 2026" */
  long: { day: "numeric", month: "long", year: "numeric" },
  /** "Fri, 21 Aug", "Fr., 21. Aug." */
  dayLabel: { weekday: "short", day: "numeric", month: "short" },
  /** "Friday, 21 August" */
  dayLabelLong: { weekday: "long", day: "numeric", month: "long" },
  /** "August 2026" */
  monthYear: { month: "long", year: "numeric" },
  /** "21 Aug", "21. Aug." */
  dayMonth: { day: "numeric", month: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof DATE_STYLES;

/** A date in a named style or explicit options. "" for an unparseable value. */
export const formatDate = (
  value: Date | string | number,
  locale: ClientLocale,
  style: DateStyle | Intl.DateTimeFormatOptions = "medium",
): string => {
  const date = toDate(value);
  if (date === null) return "";
  const options = typeof style === "string" ? DATE_STYLES[style] : style;
  return dateFormat(intlLocale(locale), options).format(date);
};

/**
 * Clock time in the user's 12h/24h preference: "14:05" / "2:05 PM".
 * The preference wins over the locale — a German who chose 12-hour gets it.
 */
export const formatTime = (
  value: Date | string | number,
  locale: ClientLocale,
  timeFormat: TimeFormat = "24h",
): string => {
  const date = toDate(value);
  if (date === null) return "--:--";
  return dateFormat(intlLocale(locale), {
    hour: timeFormat === "12h" ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: timeFormat === "12h",
  }).format(date);
};

/** A weekday name for 0 = Sunday … 6 = Saturday: "Mon" / "Mo". */
export const formatWeekday = (
  dayIndex: number,
  locale: ClientLocale,
  width: "narrow" | "short" | "long" = "short",
): string => {
  // 2023-01-01 was a Sunday; built with local parts so no zone can shift it.
  const date = new Date(2023, 0, 1 + (((dayIndex % 7) + 7) % 7), 12);
  return dateFormat(intlLocale(locale), { weekday: width }).format(date);
};

const startOfLocalDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * "Today", "Yesterday", "Tomorrow" (via `Intl.RelativeTimeFormat`, so German
 * gets „heute“/„gestern“ and „vorgestern“ for free), otherwise the day label.
 * Capitalised for use as a heading.
 */
export const formatRelativeDay = (
  value: Date | string | number,
  locale: ClientLocale,
  now: Date = new Date(),
): string => {
  const date = toDate(value);
  if (date === null) return "";
  const days = Math.round((startOfLocalDay(date) - startOfLocalDay(now)) / 86_400_000);
  if (Math.abs(days) <= 1) {
    const text = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }).format(
      days,
      "day",
    );
    return text.charAt(0).toLocaleUpperCase(intlLocale(locale)) + text.slice(1);
  }
  return formatDate(date, locale, "dayLabel");
};

/** "A, B and C" / "A, B und C". */
export const formatList = (
  items: readonly string[],
  locale: ClientLocale,
  type: "conjunction" | "disjunction" = "conjunction",
): string => {
  try {
    return new Intl.ListFormat(intlLocale(locale), { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
};

// ── durations ────────────────────────────────────────────────────────

const isEnglish = (locale: ClientLocale): boolean => locale === "en" || locale === "pseudo";

/**
 * "1:30:00" or "1.50 h" / "1,50 h", per the user's duration preference.
 *
 * English output is byte-identical to the pre-i18n `formatDuration`, so no
 * existing assertion or muscle memory moves; German gets its decimal comma
 * and a no-break space. Every form parses back through `parseDurationInput`.
 */
export const formatDurationFor = (
  seconds: number,
  locale: ClientLocale,
  durationFormat: DurationFormat = "hms",
): string =>
  isEnglish(locale)
    ? formatDuration(seconds, durationFormat)
    : formatDuration(seconds, durationFormat, intlLocale(locale));

/** Compact: "1h 23m" / "1 h 23 min". */
export const formatDurationShortFor = (seconds: number, locale: ClientLocale): string =>
  isEnglish(locale) ? formatDurationShort(seconds) : formatDurationShort(seconds, intlLocale(locale));

/**
 * Decimal hours with no unit, for tables with a unit in the header:
 * "7.50" / "7,50". Never for CSV.
 */
export const formatHours = (seconds: number, locale: ClientLocale, fractionDigits = 2): string =>
  formatDecimal(seconds / 3600, locale, fractionDigits);

// ── calendar ─────────────────────────────────────────────────────────

/**
 * The first weekday a locale expects, for places with NO stored setting.
 * The workspace's `weekStartsOn` always wins where it exists.
 */
export const defaultWeekStart = (locale: ClientLocale): WeekStart =>
  defaultWeekStartForLocale(locale === "pseudo" ? "en" : locale);
