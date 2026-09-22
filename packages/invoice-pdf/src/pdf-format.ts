/**
 * How a locale writes the figures in a server-rendered PDF — invoices and
 * report exports alike.
 *
 * Every function returns text a standard-14 font can draw, and English is
 * deliberately byte-identical to what both documents printed before they were
 * localised: an invoice without a `locale` must re-render as the page its
 * customer already holds, and ISO dates are the one date form a US and a UK
 * reader cannot read a month apart ("en" names no region). German writes what
 * a German accountant expects: 31.08.2026, 1.234,50, 19 %.
 */
import type { Locale } from "@starter/shared";
import { sanitizePdfText } from "./text.js";

export type PdfFormat = {
  /** A calendar date, from a day key or the ISO string the wire carries. */
  date: (iso: string) => string;
  /** A day key as a short column header with its weekday: "Mon 09-01". */
  weekdayDate: (dayKey: string) => string;
  /** A month key ("2026-08") as a heading: "August 2026". */
  month: (monthKey: string) => string;
  /** The moment a copy was printed. */
  timestamp: (iso: string) => string;
  /** Money, two decimals, grouped, no currency symbol (the code is in the labels). */
  amount: (value: number) => string;
  /** Hours, two decimals. */
  hours: (value: number) => string;
  /** A plain number, as many decimals as it has, no grouping — a tax rate. */
  plain: (value: number) => string;
  /** A count, grouped. */
  count: (value: number) => string;
};

/**
 * The `Intl` tag per catalog locale. A region is pinned so the output never
 * follows whatever ICU default the host happens to have.
 */
const INTL_TAG: Record<Locale, string> = { en: "en-US", de: "de-DE" };

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

const MONTH_NAMES_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * `Intl` output made drawable. WinAnsi — the encoding of pdfkit's built-in
 * fonts — has U+00A0 NO-BREAK SPACE but not U+202F NARROW NO-BREAK SPACE,
 * which several locales use for grouping and before units; left in, it renders
 * as a blank box.
 */
const drawable = (text: string): string => text.replace(/ /g, " ");

/** "2026-08-31T22:00:00.000Z" → "2026-08-31". Dates on an invoice are dates. */
const isoDate = (value: string): string => sanitizePdfText(value).slice(0, 10);

/** The UTC midnight of a day key, or `null` for anything that is not one. */
const dayMs = (value: string): number | null => {
  const match = DAY_KEY.exec(isoDate(value));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

/**
 * A fixed-point number with grouping, rounded exactly as `toFixed` rounds.
 *
 * `Intl` rounds the decimal it reads (1.005 → "1.01") while `toFixed` rounds
 * the binary double (1.005 → "1.00"). English printed with `toFixed` before
 * localisation, so the value is rounded by `toFixed` first and only the
 * punctuation is left to `Intl`.
 */
const fixed = (tag: string, value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Number(Math.abs(safe).toFixed(2));
  const text = new Intl.NumberFormat(tag, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rounded);
  return drawable(`${safe < 0 ? "-" : ""}${text}`);
};

/** The figures of a PDF in `locale`. */
export function pdfFormat(locale: Locale): PdfFormat {
  const tag = INTL_TAG[locale];
  const shared = {
    amount: (value: number): string => fixed(tag, value),
    hours: (value: number): string => fixed(tag, value),
    plain: (value: number): string =>
      drawable(
        new Intl.NumberFormat(tag, { maximumFractionDigits: 20, useGrouping: false }).format(
          value,
        ),
      ),
  };

  if (locale === "en") {
    return {
      ...shared,
      date: isoDate,
      weekdayDate: (dayKey) => {
        const ms = dayMs(dayKey);
        if (ms === null) return dayKey;
        return `${WEEKDAY_NAMES_EN[new Date(ms).getUTCDay()] ?? ""} ${dayKey.slice(5)}`;
      },
      month: (monthKey) => {
        const match = MONTH_KEY.exec(monthKey);
        if (!match) return monthKey;
        return `${MONTH_NAMES_EN[Number(match[2]) - 1] ?? monthKey} ${match[1]}`;
      },
      timestamp: (iso) => sanitizePdfText(iso),
      // English counts were `String(n)` — ungrouped.
      count: (value) => String(value),
    };
  }

  const inUtc = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat(tag, { ...options, timeZone: "UTC" });

  return {
    ...shared,
    date: (iso) => {
      const ms = dayMs(iso);
      return ms === null
        ? isoDate(iso)
        : drawable(inUtc({ day: "2-digit", month: "2-digit", year: "numeric" }).format(ms));
    },
    weekdayDate: (dayKey) => {
      const ms = dayMs(dayKey);
      return ms === null
        ? dayKey
        : drawable(inUtc({ weekday: "short", day: "2-digit", month: "2-digit" }).format(ms));
    },
    month: (monthKey) => {
      const match = MONTH_KEY.exec(monthKey);
      if (!match) return monthKey;
      const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
      return drawable(inUtc({ month: "long", year: "numeric" }).format(ms));
    },
    timestamp: (iso) => {
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return sanitizePdfText(iso);
      return drawable(`${inUtc({ dateStyle: "medium", timeStyle: "short" }).format(ms)} UTC`);
    },
    count: (value) => drawable(new Intl.NumberFormat(tag).format(value)),
  };
}
