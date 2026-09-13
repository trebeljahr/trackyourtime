import { parseDurationInput } from "@starter/shared";
import { describe, expect, it } from "vitest";

import {
  defaultWeekStart,
  formatDate,
  formatDurationFor,
  formatDurationShortFor,
  formatHours,
  formatList,
  formatMoney,
  formatNumber,
  formatRelativeDay,
  formatTime,
  formatWeekday,
} from "@/i18n/format";

/*
 * Runs in the node environment, where `navigator.languages` is the runner's —
 * so every assertion is about the LANGUAGE, and region-sensitive details
 * (en-US vs en-GB date order) are checked only where they cannot vary.
 */

const NBSP = " ";

describe("numbers and money", () => {
  it("uses the German decimal comma and grouping dot", () => {
    expect(formatNumber(1234.5, "de")).toBe("1.234,5");
    expect(formatMoney(1234.5, "EUR", "de")).toBe(`1.234,50${NBSP}€`);
  });

  it("falls back for a currency Intl rejects", () => {
    expect(formatMoney(12, "EURO", "de")).toBe("12,00 EURO");
  });
});

describe("durations", () => {
  it("keeps English byte-identical to the pre-i18n output", () => {
    expect(formatDurationFor(5400, "en", "decimal")).toBe("1.50 h");
    expect(formatDurationShortFor(5400, "en")).toBe("1h 30m");
  });

  it("prints German forms that parse back", () => {
    const decimal = formatDurationFor(5400, "de", "decimal");
    expect(decimal).toBe(`1,50${NBSP}h`);
    expect(parseDurationInput(decimal)).toBe(5400);
    const short = formatDurationShortFor(5400, "de");
    expect(short).toBe(`1${NBSP}h 30${NBSP}min`);
    expect(parseDurationInput(short)).toBe(5400);
    expect(formatHours(27_000, "de")).toBe("7,50");
  });
});

describe("dates and times", () => {
  const friday = new Date(2026, 7, 21, 14, 5);

  it("formats German day labels and 24h clocks", () => {
    expect(formatDate(friday, "de", "dayLabel")).toBe("Fr., 21. Aug.");
    expect(formatDate("2026-08-21", "de", "numeric")).toBe("21.08.2026");
    expect(formatTime(friday, "de", "24h")).toBe("14:05");
  });

  it("lets the 12h preference win over the locale", () => {
    expect(formatTime(friday, "de", "12h")).toMatch(/^2:05/);
  });

  it("names weekdays from a Sunday-based index", () => {
    expect(formatWeekday(1, "de", "long")).toBe("Montag");
    expect(formatWeekday(0, "en", "long")).toBe("Sunday");
  });

  it("says today and yesterday in the reader's language", () => {
    expect(formatRelativeDay(new Date(2026, 7, 20, 9), "de", friday)).toBe("Gestern");
    expect(formatRelativeDay(friday, "en", friday)).toBe("Today");
    expect(formatRelativeDay(new Date(2026, 7, 10), "de", friday)).toBe("Mo., 10. Aug.");
  });

  it("joins lists", () => {
    expect(formatList(["A", "B", "C"], "de")).toBe("A, B und C");
  });

  it("defaults the week start from the locale", () => {
    expect(defaultWeekStart("de")).toBe(1);
    expect(defaultWeekStart("en")).toBe(0);
  });
});
