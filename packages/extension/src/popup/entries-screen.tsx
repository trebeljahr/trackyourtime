import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
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
import { formatDurationFor, formatIdleSpanFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";
import { entryDayLabel, entryZone } from "./entry-format";
import { EntryRow, RunningRow } from "./entry-row";
import { Header } from "./header";
import { join, openTab } from "./open-tab";
import { describeSync } from "./sync-label";
import { useElapsedSec } from "./use-elapsed";

/**
 * The last two weeks of tracked time, in a list you can edit from.
 *
 * A fixed trailing window rather than the web app's sentinel range: a 380px
 * list with no filter and no search should not be able to grow without limit,
 * and the window is the worker's own — this screen renders what the snapshot
 * carries and never asks for more than one more page of it.
 *
 * The rows are read-only. Tapping one pushes the detail screen, which is where
 * every field lives; see {@link ./entry-row} for why nothing is edited in
 * place.
 */

export type EntriesScreenProps = {
  state: BackgroundState;
  /** The last failure, already translated into human terms. */
  error: string | null;
  /** A one-line outcome carried in by the transition that landed here. */
  note?: string | null;
  onBack: () => void;
  /** Where the idle strip and the running row send the user. */
  onGoTracker: () => void;
  onOpenEntry: (id: string) => void;
  onNewEntry: () => void;
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
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) {
      last.entries.push(entry);
      last.totalSec += entry.durationSec;
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

export function EntriesScreen({
  state,
  error,
  note = null,
  onBack,
  onGoTracker,
  onOpenEntry,
  onNewEntry,
  onLoadMore,
}: EntriesScreenProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const elapsedSec = useElapsedSec(state.running);

  useEffect(() => {
    if (error === null) return;
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (target.getAttribute("role") === "combobox") return;
    event.preventDefault();
    onBack();
  };

  const loadMore = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await onLoadMore();
    setBusy(false);
  };

  const sync = describeSync(
    t,
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  const timeFormat: TimeFormat = state.settings?.timeFormat ?? "24h";
  const durationFormat: DurationFormat = state.settings?.durationFormat ?? "hms";

  const page = state.entries;
  const webUrl = state.webUrl;
  // "Today" is this device's today. A row recorded in another zone keeps its
  // own day key, so an entry written last night in Berlin stays under its
  // Berlin date rather than being relabelled by where it is being read.
  const todayKey = dayKeyInZone(Date.now(), deviceTimeZone());
  const pending = new Set(page?.pendingIds ?? []);

  return (
    <div className="screen" onKeyDown={onKeyDown} data-testid="entries-screen">
      <Header
        title={t("entries.title")}
        onBack={onBack}
        onNewEntry={onNewEntry}
        sync={sync}
      />

      <div className="popup__body">
        <p
          ref={alertRef}
          className="notice screen__alert"
          role="alert"
          aria-live="assertive"
          data-testid="entries-error"
        >
          {error ?? ""}
        </p>

        {note !== null ? (
          <p className="notice notice--ok" role="status">
            {note}
          </p>
        ) : null}

        {/* A strip, not the panel: the worker parks the question on whichever
            poll tick finds it, which can be mid-scroll here, and answering it
            can stop, split or discard the running entry — mutating the very
            list being read. So the answer is given next to the clock. */}
        {state.pendingIdle !== null ? (
          <button
            type="button"
            className="alert alert--idle"
            onClick={onGoTracker}
            data-testid="idle-alert"
          >
            {t("idle.alert", {
              span: formatIdleSpanFor(state.pendingIdle.idleSec, locale),
            })}
          </button>
        ) : null}

        <div className="entries">
          {/* Pinned above the window rather than in it: the running entry is
              not part of the finished list, and this row is a signpost to the
              tracker rather than a second editor for it. */}
          {state.running !== null ? (
            <RunningRow
              entry={state.running}
              elapsedSec={elapsedSec}
              timeFormat={timeFormat}
              durationFormat={durationFormat}
              onOpen={onGoTracker}
            />
          ) : null}

          {page === null ? (
            <p className="loading" data-testid="entries-loading">
              {t("app.loading")}
            </p>
          ) : page.entries.length === 0 ? (
            <>
              {/* A list screen the user deliberately navigated to has to
                  explain itself, unlike the quick-start row, which renders
                  nothing when it has nothing to offer. */}
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
          ) : (
            <>
              {groupByDay(page.entries).map((group) => (
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
                      />
                    ))}
                  </div>
                </div>
              ))}

              {page.hasMore ? (
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
              ) : (
                /* Said out loud so the end of the list reads as a decision
                   rather than a bug. */
                <p className="entries__more" data-testid="entries-end">
                  {t("entries.end", { days: windowDays(page.from, page.to) })}{" "}
                  {webUrl === null ? null : (
                    <button
                      type="button"
                      className="button--link"
                      onClick={() => openTab(join(webUrl, "/app/track"))}
                      data-testid="entries-open-app"
                    >
                      {t("actions.openAppExternal")}
                    </button>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
