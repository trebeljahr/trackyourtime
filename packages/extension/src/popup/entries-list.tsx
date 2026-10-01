import { LoadingSkeleton } from "./loading-skeleton";
import { useState, type JSX } from "react";
import {
  dayKeyInZone,
  deviceTimeZone,
  isTempId,
  type DayKey,
  type DetailedEntry,
  type DurationFormat,
  type TimeFormat,
} from "@starter/core";
import type { BackgroundState } from "../lib/messaging";
import { formatDurationFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";
import { entryDayLabel, entryZone } from "./entry-format";
import { EntryRow, RunningRow } from "./entry-row";
import { join, openTab } from "./open-tab";
import { useElapsedSec } from "./use-elapsed";

/**
 * The last two weeks of tracked time, in a list you can edit from.
 *
 * A fixed trailing window rather than the web app's sentinel range: a 380px
 * list with no filter and no search should not be able to grow without limit,
 * and the window is the worker's own — this list renders what the snapshot
 * carries and never asks for more than one more page of it.
 *
 * The rows are read-only. Tapping one pushes the detail screen, which is where
 * every field lives; see {@link ./entry-row} for why nothing is edited in
 * place.
 */

export type EntriesListProps = {
  state: BackgroundState;
  /** Where the running row sends the user. */
  onGoTracker: () => void;
  onOpenEntry: (id: string) => void;
  onNewEntry: () => void;
  onRestartEntry?: (entry: DetailedEntry) => Promise<boolean>;
  onLoadMore: () => Promise<boolean>;
};

const MS_PER_DAY = 86_400_000;

type DayGroup = { key: DayKey; entries: DetailedEntry[]; totalSec: number };

/**
 * Group the page by the calendar day each entry belongs to IN ITS OWN ZONE.
 *
 * Order is taken from the page rather than re-sorted: the worker already
 * returns the window newest-first, with the offline overlay merged into it, and
 * a second sort here would be a second opinion about the same rows.
 */
const groupByDay = (entries: DetailedEntry[]): DayGroup[] => {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const key = dayKeyInZone(Date.parse(entry.start), entryZone(entry));
    const existing = groups.find((group) => group.key === key);
    if (existing !== undefined) {
      existing.entries.push(entry);
      existing.totalSec += entry.durationSec;
      continue;
    }
    groups.push({ key, entries: [entry], totalSec: entry.durationSec });
  }
  return groups;
};

/**
 * How many days the window covers, derived from the page itself.
 *
 * Read off `from`/`to` rather than repeated as a constant, so the sentence on
 * screen cannot drift from the window the worker actually fetched. Counted in
 * calendar days, both ends included: `to` is the current instant, so a raw
 * millisecond delta is 13 days plus however much of today has passed, and the
 * same window would read 13 before noon and 14 after.
 */
const windowDays = (from: string, to: string): number => {
  const zone = deviceTimeZone();
  // Parsed at UTC midnight for the same reason `entryDayLabel` does it: the
  // keys already name calendar days, and letting the device's offset
  // reinterpret them is exactly how a count slips by one.
  const first = Date.parse(`${dayKeyInZone(Date.parse(from), zone)}T00:00:00Z`);
  const last = Date.parse(`${dayKeyInZone(Date.parse(to), zone)}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last)) return 1;
  return Math.max(1, Math.round((last - first) / MS_PER_DAY) + 1);
};

export function EntriesList({
  state,
  onGoTracker,
  onOpenEntry,
  onNewEntry,
  onRestartEntry,
  onLoadMore,
}: EntriesListProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<DetailedEntry | null>(null);
  const running = restarting ?? state.running;
  const elapsedSec = useElapsedSec(running);

  const restart = async (entry: DetailedEntry): Promise<void> => {
    if (running !== null || onRestartEntry === undefined) return;
    const now = new Date().toISOString();
    setRestarting({ ...entry, id: `restarting-${entry.id}`, start: now,
      end: null, durationSec: 0, createdAt: now, updatedAt: now });
    try {
      await onRestartEntry(entry);
    } finally {
      setRestarting(null);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await onLoadMore();
    setBusy(false);
  };

  const timeFormat: TimeFormat = state.settings?.timeFormat ?? "24h";
  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";

  const page = state.entries;
  const webUrl = state.webUrl;
  // "Today" is this device's today. A row recorded in another zone keeps its
  // own day key, so an entry written last night in Berlin stays under its
  // Berlin date rather than being relabelled by where it is being read.
  const todayKey = dayKeyInZone(Date.now(), deviceTimeZone());
  const pending = new Set(page?.pendingIds ?? []);
  const groups = groupByDay((page?.entries ?? []).filter(
    (entry) => entry.end !== null && entry.id !== running?.id,
  ));
  if (running !== null) {
    let today = groups.find((group) => group.key === todayKey);
    if (today === undefined) {
      today = { key: todayKey, entries: [], totalSec: 0 };
      groups.unshift(today);
    }
    // Only the part after local midnight belongs in today's tally. Using
    // timestamps also handles days where the clocks move forward or back.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    today.totalSec += Math.min(elapsedSec, Math.max(0,
      Math.floor((Date.now() - midnight.getTime()) / 1000),
    ));
  }

  return (
    <div className="tracker-entries" data-testid="entries-list">
      <div className="tracker-entries__header">
        <h2>{t("entries.title")}</h2>
      </div>
        <div className="entries">
          {page === null ? (
            <LoadingSkeleton variant="entries" label={t("app.loading")} testId="entries-loading" />
          ) : groups.length === 0 ? (
            <>
              {/* Explain the empty history while keeping manual entry available. */}
              <p className="entries__empty" data-testid="entries-empty">
                {t("entries.empty", { days: windowDays(page.from, page.to) })}
              </p>
              <button
                type="button"
                className="button button--primary button--block"
                onClick={onNewEntry}
                data-testid="entries-empty-new"
              >
                {t("entries.newEntry")}
              </button>
            </>
          ) : null}
          {groups.length > 0 && (
            <>
              {groups.map((group) => (
                <div key={group.key}>
                  <div className="entry-day">
                    <span className="entry-day__label">
                      {entryDayLabel(group.key, todayKey, t, locale)}
                    </span>
                    <span className="entry-day__total">
                      {formatDurationFor(group.totalSec, locale, durationFormat)}
                    </span>
                  </div>

                  <div className="entries">
                    {group.key === todayKey && running !== null ? (
                      <RunningRow
                        entry={running}
                        elapsedSec={elapsedSec}
                        timeFormat={timeFormat}
                        durationFormat={durationFormat}
                        onOpen={onGoTracker}
                      />
                    ) : null}

                    {group.entries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        timeFormat={timeFormat}
                        durationFormat={durationFormat}
                        // Either half is enough to mark a row unsent: the
                        // overlay knows a queued edit, and a temp id says the
                        // row itself has never reached the server.
                        pending={pending.has(entry.id) || isTempId(entry.id)}
                        onOpen={() => onOpenEntry(entry.id)}
                        onRestart={running === null && onRestartEntry ? () => { void restart(entry); } : undefined}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {page?.hasMore ? (
                <button
                  type="button"
                  className="button button--block"
                  disabled={busy}
                  onClick={() => {
                    void loadMore();
                  }}
                  data-testid="entries-more"
                >
                  {busy ? t("app.loading") : t("entries.loadOlder")}
                </button>
              ) : page !== null ? (
                /* Said out loud so the end of the list reads as a decision
                   rather than a bug. */
                <p className="entries__more" data-testid="entries-end">
                  {webUrl === null ? t("entries.end") : (
                    <button
                      type="button"
                      className="button--link"
                      onClick={() => openTab(join(webUrl, "/app/track"))}
                      data-testid="entries-open-app"
                    >
                      {t("entries.end")}
                    </button>
                  )}
                </p>
              ) : null}
            </>
          )}
        </div>
    </div>
  );
}
