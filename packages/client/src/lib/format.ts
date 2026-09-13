"use client";

import * as React from "react";
import {
  DEFAULT_IDLE_SETTINGS,
  DEFAULT_MAX_DURATION_SETTINGS,
  entryDurationSec,
  type DurationEntry,
  type DurationFormat,
  type TimeFormat,
  type WeekStart,
  type ResolvedSettings,
} from "@starter/shared";
import type { ClientLocale } from "@/i18n/config";
import {
  formatDate,
  formatDurationFor,
  formatDurationShortFor,
  formatMoney as formatLocaleMoney,
  formatTime,
} from "@/i18n/format";
import { getActiveLocale, useLocale } from "@/i18n/locale-store";
import { trpc } from "@/lib/trpc";

/** Used until `settings.get` resolves, so nothing renders blank on first paint. */
export const FALLBACK_SETTINGS: ResolvedSettings = {
  workspaceId: "",
  userId: "",
  defaultHourlyRate: 0,
  currency: "EUR",
  weekStartsOn: 1,
  timeFormat: "24h",
  durationFormat: "hms",
  theme: "system",
  locale: "system",
  idle: DEFAULT_IDLE_SETTINGS,
  maxDuration: DEFAULT_MAX_DURATION_SETTINGS,
};

/**
 * "€1,234.50" / "1.234,50 €". Falls back to "1,234.50 XYZ" for codes Intl
 * rejects. Formats in the active locale unless one is given — see
 * i18n/format.ts, which this delegates to.
 */
export const formatMoney = (
  amount: number,
  currency: string,
  locale: ClientLocale = getActiveLocale()
): string => formatLocaleMoney(amount, currency, locale);

/** Clock time of an ISO timestamp in the user's 12h/24h preference. */
export const formatClock = (
  iso: string,
  timeFormat: TimeFormat = "24h",
  locale: ClientLocale = getActiveLocale()
): string => formatTime(iso, locale, timeFormat);

/** Calendar date of an ISO timestamp, e.g. "Fri, 21 Aug" / "Fr., 21. Aug.". */
export const formatDayLabel = (
  iso: string,
  locale: ClientLocale = getActiveLocale()
): string => formatDate(iso, locale, "dayLabel") || iso;

export type FormatSettings = {
  settings: ResolvedSettings;
  /** The locale everything below formats in. */
  locale: ClientLocale;
  /** False while `settings.get` is still in flight (fallbacks are in use). */
  isLoaded: boolean;
  currency: string;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  weekStartsOn: WeekStart;
  /** "1:23:45" or "1.40 h" / "1,40 h", per the user's duration preference. */
  duration: (seconds: number) => string;
  /** Compact form — "1h 23m" / "1 h 23 min". Never affected by the duration preference. */
  durationShort: (seconds: number) => string;
  /** Live duration of an entry, running entries measured against `nowMs`. */
  entryDuration: (entry: DurationEntry, nowMs?: number) => number;
  money: (amount: number) => string;
  clock: (iso: string) => string;
};

/**
 * Formatting bound to the signed-in user's workspace settings.
 *
 * Every screen renders durations and money through this hook so a change to
 * `durationFormat` or `currency` reaches the whole app from one place.
 */
export const useFormatSettings = (): FormatSettings => {
  const query = trpc.settings.get.useQuery(undefined, {
    staleTime: 60_000,
  });

  const locale = useLocale();
  const settings = query.data ?? FALLBACK_SETTINGS;
  const { currency, timeFormat, durationFormat, weekStartsOn } = settings;

  return React.useMemo<FormatSettings>(
    () => ({
      settings,
      locale,
      isLoaded: query.data !== undefined,
      currency,
      timeFormat,
      durationFormat,
      weekStartsOn,
      duration: (seconds) => formatDurationFor(seconds, locale, durationFormat),
      durationShort: (seconds) => formatDurationShortFor(seconds, locale),
      entryDuration: (entry, nowMs = Date.now()) =>
        entryDurationSec(entry, nowMs),
      money: (amount) => formatLocaleMoney(amount, currency, locale),
      clock: (iso) => formatTime(iso, locale, timeFormat),
    }),
    [settings, locale, query.data, currency, timeFormat, durationFormat, weekStartsOn]
  );
};
