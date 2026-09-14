"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Timer, Upload } from "lucide-react";
import { toLocalDateKey, type DetailedEntry } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { EntryEditDialog } from "@/components/tracker/entry-edit-dialog";
import { EntryRow } from "@/components/tracker/entry-row";
import {
  dayHeadingLabel,
  groupEntriesByDay,
  type DayGroup,
} from "@/components/tracker/grouping";
import { LiveDuration } from "@/components/tracker/live-duration";
import { ownEntries, useViewerId } from "@/components/tracker/own-entries";
import {
  TRACKER_LIST_INPUT,
  useEntryMutations,
} from "@/components/tracker/use-entry-mutations";
import { useQuickStarts } from "@/hooks/use-favorites";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/**
 * Where a day heading comes to rest when it sticks.
 *
 * The app header is a fixed 3.5rem on web; the tracker bar under it is not —
 * it grows a second line for the offline badges. `--tracker-bar-height` is
 * published by the bar itself via a ResizeObserver, and the fallback is the
 * bar's one-line height, so the heading still lands correctly on the first
 * paint before the observer has measured anything.
 *
 * `--app-header-offset` is the header's height including the status-bar
 * inset, and is set only by styles/native.css under `html.cap`. On web it is
 * undefined and the fallback makes this the same string it always was.
 */
const STICKY_TOP =
  "calc(var(--app-header-offset, 3.5rem) + var(--tracker-bar-height, 4.1rem))";

/** Rough rendered height of one row and one heading, in px. */
const ROW_HEIGHT = 45;
const HEADING_HEIGHT = 37;

function EntrySkeletons(): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="entry-list-skeleton">
      {[0, 1, 2].map((group) => (
        <div key={group} className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
          </div>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0"
            >
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DayHeader({
  group,
  live,
}: {
  group: DayGroup;
  /**
   * Whether the running timer belongs to this day. Only that one header may
   * subscribe to the per-second clock — every other day's total is settled, and
   * a `LiveDuration` there would re-render a heading once a second to print the
   * same number.
   */
  live: boolean;
}): React.JSX.Element {
  const format = useFormatSettings();
  const tc = useT("common");

  return (
    <div
      className="sticky z-20 flex flex-wrap items-center justify-between gap-2 rounded-t-lg border-b border-border bg-muted px-3 py-2"
      style={{ top: STICKY_TOP }}
      data-testid="day-header"
    >
      <span className="text-sm font-medium" data-testid="day-label">
        {dayHeadingLabel(group.date, format.locale)}
      </span>
      <span className="flex items-center gap-4 text-sm">
        <span className="text-muted-foreground" data-testid="day-count">
          {tc("counts.entries", { count: group.entryCount })}
        </span>
        {group.amount > 0 ? (
          <span className="text-muted-foreground" data-testid="day-amount">
            {format.money(group.amount)}
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{tc("fields.total")}</span>
          {live ? (
            <LiveDuration
              baseSec={group.totalSec}
              matchDate={group.date}
              className="text-sm font-medium"
              testId="day-total"
            />
          ) : (
            <span
              className="font-mono text-sm font-medium tabular-nums"
              data-testid="day-total"
            >
              {format.duration(group.totalSec)}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * The day-grouped log under the tracker bar. Pages through the whole history
 * with the server cursor, and keeps every field editable in place.
 *
 * The list is not windowed. It is kept cheap three other ways instead, because
 * a windowed list cannot hold a row that grows a popover, a combobox and an
 * inline editor without measuring every one of them:
 *
 *  - each day is a `content-visibility: auto` section, so the browser skips
 *    layout and paint for the days that are off screen while the scrollbar
 *    still reflects the whole history (`contain-intrinsic-size` is seeded from
 *    the day's own row count, so scrolling does not jump as days render);
 *  - rows are `React.memo`, and both `useEntryMutations` and `useQuickStarts`
 *    hand back stable objects, so a second of running clock re-renders one
 *    duration rather than the log;
 *  - only the day the timer is running in subscribes to that clock at all.
 */
export function EntryList(): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const mutations = useEntryMutations();
  const quickStarts = useQuickStarts();
  // The query, not `useRunningEntry` — this only needs to know WHICH day is
  // live, and the hook's live clock would re-render the whole list once a
  // second to answer a question whose answer changes twice a day.
  const running =
    trpc.entries.current.useQuery(undefined, { staleTime: 15_000 }).data ?? null;
  const [editing, setEditing] = React.useState<DetailedEntry | null>(null);

  const query = trpc.entries.list.useInfiniteQuery(TRACKER_LIST_INPUT, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // A refetch on an infinite query refetches EVERY page it holds, so a
    // window flip after scrolling far back would replay the whole history.
    // The socket already invalidates on every remote change; this is the
    // backstop, and it does not need to be instant.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // Only the viewer's own entries: see components/tracker/own-entries.ts for
  // why a colleague's row must never reach an editable list.
  const viewerId = useViewerId();
  const entries = React.useMemo(
    () =>
      ownEntries(query.data?.pages.flatMap((page) => page.entries) ?? [], viewerId),
    [query.data, viewerId]
  );
  const days = React.useMemo(() => groupEntriesByDay(entries), [entries]);

  const runningDate =
    running === null ? null : toLocalDateKey(new Date(running.start));

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const loadedPages = query.data?.pages.length ?? 0;

  // Guarded with a ref rather than `isFetchingNextPage`: the observer fires
  // again the moment a page lands and the sentinel is still in view, and React
  // Query's pending flag has not flipped back yet at that instant.
  const loadingRef = React.useRef(false);
  React.useEffect(() => {
    loadingRef.current = isFetchingNextPage;
  }, [isFetchingNextPage]);

  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const node = sentinelRef.current;
    if (node === null || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (records) => {
        if (loadingRef.current) return;
        if (records.some((record) => record.isIntersecting)) {
          void fetchNextPage();
        }
      },
      // A screen ahead of the fold: the next page is already on the wire by
      // the time the last day scrolls into view, so the list never visibly
      // stops.
      { rootMargin: "800px 0px" }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
    // Keyed on pages, not on the filtered entry count: a page holding only
    // colleagues' entries adds no rows, and the sentinel must still re-arm.
  }, [fetchNextPage, hasNextPage, loadedPages]);

  const handleEdit = React.useCallback((entry: DetailedEntry): void => {
    setEditing(entry);
  }, []);

  const closeEditor = React.useCallback((): void => {
    setEditing(null);
  }, []);

  if (query.isPending) return <EntrySkeletons />;

  if (query.isError) {
    return (
      <EmptyState
        icon={Timer}
        title={t("list.loadError")}
        description={userErrorMessage(query.error, undefined, tc)}
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
            data-testid="entries-retry"
          >
            {t("list.retry")}
          </Button>
        }
        testId="entries-error"
      />
    );
  }

  // A page can be entirely colleagues' entries for somebody who may see them;
  // filtered to nothing, that is "keep loading", not "nothing tracked yet".
  if (entries.length === 0 && !hasNextPage) {
    return (
      <EmptyState
        icon={Timer}
        title={t("list.emptyTitle")}
        description={t("list.emptyDescription")}
        action={
          // Somebody arriving from another tracker has years of history sitting
          // in a file, and this screen is where they find out it can come with
          // them. The empty state is the only place that question is live.
          <Button type="button" variant="outline" asChild>
            <Link href="/settings?tab=data" data-testid="entries-empty-import">
              <Upload className="size-4" />
              {t("list.importHistory")}
            </Link>
          </Button>
        }
        testId="entries-empty"
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="entry-list">
      {days.map((day) => (
        <section
          key={day.date}
          className="rounded-lg border border-border"
          // `auto` keeps the last measured size once the day has been rendered
          // once, so this estimate only ever has to be right the first time.
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: `auto ${HEADING_HEIGHT + day.entryCount * ROW_HEIGHT}px`,
          }}
          data-testid="day-group"
          data-date={day.date}
        >
          <DayHeader group={day} live={day.date === runningDate} />
          {day.entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              mutations={mutations}
              quickStarts={quickStarts}
              onEdit={handleEdit}
            />
          ))}
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" className="h-px" />

      {isFetchingNextPage ? (
        <div
          className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground"
          data-testid="entries-loading-more"
        >
          <Loader2 className="size-4 animate-spin" />
          {t("list.loadingMore")}
        </div>
      ) : null}

      {/* The observer does the loading; this is the manual fallback for the
          cases it cannot cover — a browser without IntersectionObserver, and a
          fetch that failed and left the sentinel sitting in view. */}
      {hasNextPage && !isFetchingNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => void fetchNextPage()}
            data-testid="entries-load-more"
          >
            {t("list.loadMore")}
          </Button>
        </div>
      ) : null}

      {!hasNextPage ? (
        <p
          className="py-2 text-center text-xs text-muted-foreground"
          data-testid="entries-end"
        >
          {t("list.end")}
        </p>
      ) : null}

      <EntryEditDialog
        entry={editing}
        onClose={closeEditor}
        mutations={mutations}
      />
    </div>
  );
}
