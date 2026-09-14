import type { CSSProperties, JSX } from "react";
import {
  type DetailedEntry,
  type DurationFormat,
  type TimeEntry,
  type TimeFormat,
} from "@starter/core";
import {
  entryRangeLabel,
  entrySubtitle,
  entryTitle,
  formatElapsed,
} from "./entry-format";
import { formatDurationFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";

/**
 * One row of the entry list, and the running entry's variant of it.
 *
 * Read-only, and the whole row is one button that pushes the detail screen.
 * There is no inline delete and no inline field editing, for three reasons:
 * `Combobox` caps its dropdown at 190px and would clip at an arbitrary scroll
 * offset even with the flip fix; at 380px the row's width is already spent on
 * a description, a range and a duration; and a 28px destructive control next
 * to a scroll target is a mis-tap generator.
 */

/** An entry with no project keeps an outline rather than borrowing a colour. */
const dotStyle = (color: string | null): CSSProperties =>
  color === null ? {} : { backgroundColor: color, borderColor: color };

export type EntryRowProps = {
  entry: DetailedEntry;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  /**
   * True while a mutation for this row is still in the offline queue. Such a
   * row is not editable — a second edit stacked on an unsent one would replay
   * in an order the user never chose — but it still opens: the detail screen
   * locks the fields itself, and its delete button is the only way to take
   * back something logged offline before it is ever sent. Disabling the row
   * here made that button unreachable.
   */
  pending: boolean;
  onOpen: () => void;
};

export function EntryRow({
  entry,
  timeFormat,
  durationFormat,
  pending,
  onOpen,
}: EntryRowProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const described = entry.description.trim() !== "";

  return (
    <button
      type="button"
      className="entry"
      onClick={onOpen}
      title={pending ? t("entry.pendingTitle") : undefined}
      data-testid="entry-row"
      data-entry-id={entry.id}
      data-invoiced={entry.invoiceId !== null ? "true" : "false"}
      data-syncing={pending ? "true" : "false"}
    >
      <span
        className="entry__dot"
        style={dotStyle(entry.projectColor)}
        aria-hidden="true"
      />

      <span className="entry__text">
        <span
          className={described ? "entry__label" : "entry__label combobox__muted"}
        >
          {entryTitle(entry, t)}
        </span>
        <span className="entry__hint">{entrySubtitle(entry, t)}</span>
      </span>

      <span className="entry__times">
        <span className="entry__range">
          {entryRangeLabel(entry, timeFormat)}
        </span>
        <span className="entry__duration">
          {formatDurationFor(entry.durationSec, locale, durationFormat)}
        </span>
      </span>
    </button>
  );
}

export type RunningRowProps = {
  entry: TimeEntry;
  /** Ticked in the popup — the service worker sleeps and cannot be the clock. */
  elapsedSec: number;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  /** Goes to the tracker: this row is a signpost, never an editor. */
  onOpen: () => void;
};

/**
 * The running entry, pinned above the list.
 *
 * It is not in the list itself — the worker filters an open end out of the
 * window — because `entries.list` matches on overlap and the same row would
 * otherwise be editable in two places, with two different id semantics while a
 * start is still queued. Tapping it goes to the tracker, which is where a
 * running entry is edited.
 */
export function RunningRow({
  entry,
  elapsedSec,
  timeFormat,
  durationFormat,
  onOpen,
}: RunningRowProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const described = entry.description.trim() !== "";

  return (
    <button
      type="button"
      className="entry entry--running"
      onClick={onOpen}
      data-testid="entry-running"
      data-entry-id={entry.id}
    >
      <span className="entry__dot" aria-hidden="true" />

      <span className="entry__text">
        <span
          className={described ? "entry__label" : "entry__label combobox__muted"}
        >
          {entryTitle(entry, t)}
        </span>
        <span className="entry__hint">{t("entry.running")}</span>
      </span>

      <span className="entry__times">
        <span className="entry__range">
          {entryRangeLabel(entry, timeFormat)}
        </span>
        <span className="entry__duration">
          {formatElapsed(elapsedSec, durationFormat, locale)}
        </span>
      </span>
    </button>
  );
}
