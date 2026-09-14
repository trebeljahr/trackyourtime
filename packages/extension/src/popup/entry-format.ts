/**
 * How an entry reads in a 380px list.
 *
 * Every formatter here delegates to `@starter/shared` and then trims: the
 * shared helpers are written for a screen with room, and the popup's job is to
 * decide what to drop, never to re-implement how a duration or a clock time is
 * spelled.
 */
import {
  addDaysToKey,
  deviceTimeZone,
  formatClockInZone,
  type DayKey,
  type DetailedEntry,
  type DurationFormat,
  type QuickStart,
  type QuickStartLabels,
  type TimeEntry,
  type TimeFormat,
} from "@starter/core";
import type { Locale } from "@starter/shared";
import { formatDayKey, formatDurationFor } from "../i18n/format";
import type { PopupT } from "../i18n/use-t";

/**
 * A ticking clock in the user's own duration format.
 *
 * The format is a parameter rather than a constant because the popup can now
 * set it, and a running clock that stayed h:mm:ss would put two spellings of a
 * duration on one screen. In h:mm:ss the leading "0:" is trimmed: at 380px it
 * is noise for the first hour, which is where most entries live. Decimal has
 * nothing to trim, so the branch simply does not fire.
 */
export function formatElapsed(
  seconds: number,
  format: DurationFormat,
  locale: Locale,
): string {
  const shown = formatDurationFor(seconds, locale, format);
  return shown.startsWith("0:") ? shown.slice(2) : shown;
}

/**
 * The zone an entry's clock times mean.
 *
 * Falling back to this device is what stops a row recorded before entries
 * carried a zone from rendering as an empty string; using the entry's own zone
 * where it has one is what stops a Berlin entry reading 07:30 in Tokyo.
 */
export function entryZone(entry: Pick<TimeEntry, "timeZone">): string {
  return entry.timeZone ?? deviceTimeZone();
}

/** "09:00–10:24", in the user's own clock format. */
export function entryRangeLabel(
  entry: Pick<TimeEntry, "start" | "end" | "timeZone">,
  timeFormat: TimeFormat,
): string {
  const zone = entryZone(entry);
  const start = formatClockInZone(entry.start, zone, timeFormat);
  // An open end is a running entry, which the list never shows — but a row
  // rendered from the offline overlay can reach here mid-write.
  const end =
    entry.end === null ? "…" : formatClockInZone(entry.end, zone, timeFormat);
  return `${start}–${end}`;
}

/** "Today", "Yesterday", else "Fri 5 Sep" in the reader's language. */
export function entryDayLabel(
  dayKey: DayKey,
  todayKey: DayKey,
  t: PopupT,
  locale: Locale,
): string {
  if (dayKey === todayKey) return t("entry.today");
  if (dayKey === addDaysToKey(todayKey, -1)) return t("entry.yesterday");
  return formatDayKey(dayKey, locale);
}

/** An entry with no description is a real state, not a blank row. */
export function entryTitle(entry: Pick<TimeEntry, "description">, t: PopupT): string {
  const trimmed = entry.description.trim();
  return trimmed === "" ? t("entry.noDescription") : trimmed;
}

/** "Acme · Landing page" — the denormalized labels the server already sent. */
export function entrySubtitle(entry: DetailedEntry, t: PopupT): string {
  const parts = [entry.clientName, entry.projectName, entry.taskName].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length === 0 ? t("fields.noProject") : parts.join(" · ");
}

type Labelled = QuickStart & Partial<QuickStartLabels>;

/**
 * `quickStartLabel` from `@starter/shared`, with its one fallback word said in
 * the popup's language. The order — description, project, task — is the
 * shared rule and must stay in step with it.
 */
export function quickLabel(quick: Labelled, t: PopupT): string {
  const description = quick.description.trim();
  if (description !== "") return description;
  if (quick.projectName) return quick.projectName;
  if (quick.taskName) return quick.taskName;
  return t("entry.noDescription");
}

/**
 * `quickStartHint` from `@starter/shared`, translated: project and client, or
 * null when it would only repeat the label. Kept rule for rule with the shared
 * helper, which Raycast still uses in English.
 */
export function quickHint(quick: Labelled, t: PopupT): string | null {
  if (quick.projectMissing === true) return t("entry.projectDeleted");
  if (!quick.projectName) return quick.taskName ?? null;
  if (quick.description.trim() === "") return quick.clientName ?? null;

  const project = quick.projectArchived
    ? t("entry.projectArchived", { project: quick.projectName })
    : quick.projectName;
  return quick.clientName
    ? t("entry.clientAndProject", { client: quick.clientName, project })
    : project;
}
