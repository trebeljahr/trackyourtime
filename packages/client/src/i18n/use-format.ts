"use client";

import * as React from "react";
import type { DurationFormat, TimeFormat } from "@starter/shared";

import type { ClientLocale } from "@/i18n/config";
import {
  formatDate,
  formatDecimal,
  formatDurationFor,
  formatDurationShortFor,
  formatHours,
  formatList,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeDay,
  formatTime,
  formatWeekday,
  intlLocale,
  type DateStyle,
} from "@/i18n/format";
import { useLocale } from "@/i18n/locale-store";

export type LocaleFormat = {
  locale: ClientLocale;
  /** The BCP 47 tag for any `Intl` call not covered below. */
  intlLocale: string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  decimal: (value: number, fractionDigits?: number) => string;
  percent: (ratio: number, fractionDigits?: number) => string;
  money: (amount: number, currency: string) => string;
  date: (value: Date | string | number, style?: DateStyle | Intl.DateTimeFormatOptions) => string;
  time: (value: Date | string | number, timeFormat?: TimeFormat) => string;
  weekday: (dayIndex: number, width?: "narrow" | "short" | "long") => string;
  relativeDay: (value: Date | string | number, now?: Date) => string;
  list: (items: readonly string[], type?: "conjunction" | "disjunction") => string;
  duration: (seconds: number, durationFormat?: DurationFormat) => string;
  durationShort: (seconds: number) => string;
  hours: (seconds: number, fractionDigits?: number) => string;
};

/**
 * i18n/format.ts bound to the locale this component renders in.
 *
 * For anything that also depends on the user's display preferences
 * (currency, 12h/24h, hms/decimal), prefer `useFormatSettings()` from
 * lib/format.ts, which calls this and applies them.
 */
export const useFormat = (): LocaleFormat => {
  const locale = useLocale();
  return React.useMemo<LocaleFormat>(
    () => ({
      locale,
      intlLocale: intlLocale(locale),
      number: (value, options) => formatNumber(value, locale, options),
      decimal: (value, fractionDigits) => formatDecimal(value, locale, fractionDigits),
      percent: (ratio, fractionDigits) => formatPercent(ratio, locale, fractionDigits),
      money: (amount, currency) => formatMoney(amount, currency, locale),
      date: (value, style) => formatDate(value, locale, style),
      time: (value, timeFormat) => formatTime(value, locale, timeFormat),
      weekday: (dayIndex, width) => formatWeekday(dayIndex, locale, width),
      relativeDay: (value, now) => formatRelativeDay(value, locale, now),
      list: (items, type) => formatList(items, locale, type),
      duration: (seconds, durationFormat) => formatDurationFor(seconds, locale, durationFormat),
      durationShort: (seconds) => formatDurationShortFor(seconds, locale),
      hours: (seconds, fractionDigits) => formatHours(seconds, locale, fractionDigits),
    }),
    [locale],
  );
};
