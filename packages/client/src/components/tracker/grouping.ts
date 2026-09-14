import { sumAmounts, toLocalDateKey, type DetailedEntry } from "@starter/shared";

import type { ClientLocale } from "@/i18n/config";
import { formatDate } from "@/i18n/format";
import { getTranslator } from "@/i18n/translator";

export type DayGroup = {
  /** Local "YYYY-MM-DD". */
  date: string;
  /** Every entry of the day, newest first. */
  entries: DetailedEntry[];
  entryCount: number;
  /** Finished seconds only — the running entry is added live by the header. */
  totalSec: number;
  billableSec: number;
  amount: number;
};

/**
 * Bucket entries (already sorted newest first) into days.
 *
 * Look-alike entries used to be collapsed into an expandable cluster, the way
 * some trackers do it. That hid rows behind a disclosure the user never asked for:
 * a new entry could vanish into an existing group instead of appearing at the
 * top, and deleting one member re-collapsed the whole group. Every entry now
 * gets its own row.
 */
export const groupEntriesByDay = (entries: DetailedEntry[]): DayGroup[] => {
  const days: DayGroup[] = [];
  let currentDay: DayGroup | null = null;

  for (const entry of entries) {
    const date = toLocalDateKey(new Date(entry.start));

    if (currentDay === null || currentDay.date !== date) {
      currentDay = {
        date,
        entries: [],
        entryCount: 0,
        totalSec: 0,
        billableSec: 0,
        amount: 0,
      };
      days.push(currentDay);
    }

    currentDay.entries.push(entry);
    currentDay.entryCount += 1;
    currentDay.totalSec += entry.durationSec;
    if (entry.billable) currentDay.billableSec += entry.durationSec;
  }

  for (const day of days) {
    // A colleague's row whose money is withheld arrives with `amount: null`;
    // it contributes nothing to the day's own-visible total rather than
    // failing the sum.
    day.amount = sumAmounts(
      day.entries.flatMap((entry) => (entry.amount === null ? [] : [entry.amount]))
    );
  }

  return days;
};

/**
 * "Today" / "Yesterday" / "Fri, 21 Aug" for a local date key, in `locale`.
 * The year is added only for a day in another year.
 */
export const dayHeadingLabel = (
  dateKey: string,
  locale: ClientLocale,
  now: Date = new Date()
): string => {
  const tc = getTranslator(locale, "common");
  const today = toLocalDateKey(now);
  if (dateKey === today) return tc("time.today");

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === toLocalDateKey(yesterday)) return tc("time.yesterday");

  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  return formatDate(parsed, locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year:
      parsed.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
};
