"use client";

import * as React from "react";
import {
  Copy,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import {
  isSameZone,
  rollEndAfterStart,
  quickStartKey,
  spansDayBoundaryInZone,
  toQuickStart,
  zoneLabel,
  type DetailedEntry,
} from "@starter/shared";
import {
  deviceTimeZone,
  entryFieldsFrom,
  type EntryFields,
} from "@starter/core";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DurationInput } from "@/components/duration-input";
import { ProjectTaskPicker } from "@/components/entry-fields/project-task-picker";
import { TagPicker } from "@/components/tags/tag-picker";
import { BillableGlyph } from "@/components/tracker/billable-glyph";
import { LiveDuration } from "@/components/tracker/live-duration";
import { TimeField } from "@/components/tracker/time-field";
import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import type { QuickStarts } from "@/hooks/use-favorites";
import { useT } from "@/i18n/use-t";
import { isTempId } from "@/lib/offline";
import { useFormatSettings } from "@/lib/format";
import { cn } from "@/lib/utils";

const MINUTE_MS = 60_000;

export type EntryRowProps = {
  entry: DetailedEntry;
  mutations: EntryMutations;
  /**
   * Threaded down rather than hooked per row: the list renders dozens of rows,
   * and each `useQuickStarts()` would spin up its own mutation observers for a
   * menu item that is usually never opened.
   */
  quickStarts: QuickStarts;
  onEdit: (entry: DetailedEntry) => void;
  /** Rendered inside an expanded collapse group. */
  nested?: boolean;
};

/**
 * One tracked block. Everything on the row is editable in place — description,
 * project, billable, both clock times and the duration — because the edit a
 * user actually makes is a two-minute correction, not a form submission.
 */
function EntryRowImpl({
  entry,
  mutations,
  quickStarts,
  onEdit,
  nested = false,
}: EntryRowProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("tracker");
  const tc = useT("common");
  const running = entry.end === null;
  // A locally-invented entry has no server id yet; editing it would be lost
  // when the queued create replays.
  const syncing = isTempId(entry.id);

  const [editingDescription, setEditingDescription] = React.useState(false);
  // The row is already write-through and re-renders straight off the query
  // cache, so the pickers read the entry itself rather than a local copy —
  // there is nothing to buffer between a pick and the optimistic update.
  const fields = React.useMemo(() => entryFieldsFrom(entry), [entry]);
  const applyFields = React.useCallback(
    (_next: EntryFields, patch: Partial<EntryFields>): void => {
      mutations.updateEntry({ id: entry.id, ...patch });
    },
    [entry.id, mutations]
  );

  const [draft, setDraft] = React.useState(entry.description);

  const commitDescription = React.useCallback((): void => {
    setEditingDescription(false);
    if (draft === entry.description) return;
    mutations.updateEntry({ id: entry.id, description: draft });
  }, [draft, entry.description, entry.id, mutations]);

  // The zone this entry was RECORDED in. Times are read and written in it, so
  // an entry written at 23:30 in Berlin still reads 23:30 when opened from
  // another zone, and retyping it does not move the entry. Entries recorded
  // before the field existed fall back to this device's zone.
  const entryZone = entry.timeZone ?? deviceTimeZone();
  const foreignZone = !isSameZone(
    entryZone,
    deviceTimeZone(),
    Date.parse(entry.start)
  );

  const handleStartCommit = React.useCallback(
    (iso: string): void => {
      if (entry.end === null) {
        mutations.updateEntry({ id: entry.id, start: iso });
        return;
      }
      // Keep the block's length when the start is dragged past the end.
      const end =
        Date.parse(iso) >= Date.parse(entry.end)
          ? new Date(
              Date.parse(iso) + Math.max(MINUTE_MS, entry.durationSec * 1000)
            ).toISOString()
          : entry.end;
      mutations.updateEntry({ id: entry.id, start: iso, end });
    },
    [entry.durationSec, entry.end, entry.id, mutations]
  );

  const handleEndCommit = React.useCallback(
    (iso: string): void => {
      // An end at or before the start means the timer ran past midnight —
      // "23:30 to 00:30" is an hour, not a minute. Roll it to the next day
      // rather than clamping, which used to silently destroy the entry.
      const end = rollEndAfterStart(entry.start, iso);
      mutations.updateEntry({ id: entry.id, end });
    },
    [entry.id, entry.start, mutations]
  );

  // What pinning this row would pin, and whether that is already pinned. The
  // id is the FAVORITE's, not the entry's — unpinning removes the pin, and
  // leaves the tracked time exactly where it is.
  const quick = toQuickStart(entry);
  const quickKey = quickStartKey(quick);
  const favoriteId =
    quickStarts.favorites.find(
      (favorite) => quickStartKey(favorite) === quickKey
    )?.id ?? null;
  const pinned = favoriteId !== null;

  const handleDurationCommit = React.useCallback(
    (seconds: number): void => {
      if (running) return;
      const end = new Date(
        Date.parse(entry.start) + Math.max(60, seconds) * 1000
      ).toISOString();
      mutations.updateEntry({ id: entry.id, end });
    },
    [entry.id, entry.start, mutations, running]
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/40",
        // Every row shares ONE column template, so description, project,
        // client, task, tags and the times line up down the list instead of
        // each row packing its own width. Track sizes are `fr` or fixed —
        // never `auto`/`min-content`, which resolve against a single row's
        // content and would bring the ragged columns straight back.
        //
        // Two templates for the same ELEVEN items: the fixed part of the row
        // (times, duration, amount) costs ~23rem whatever the viewport, so
        // below `xl` the client and the amount collapse to zero-width tracks
        // rather than being hidden — `display: none` would drop a grid item
        // and slide every later column one track left. The lower switch is
        // 1140px rather than `lg`, because at 1024 what is left over is so
        // thin the project reads "A…"; below it the row stays a wrapping flex
        // line, ragged but legible.
        "min-[1140px]:grid min-[1140px]:grid-cols-[minmax(0,1.8fr)_minmax(0,1.4fr)_0px_minmax(0,1.2fr)_minmax(5rem,1fr)_2rem_12.5rem_5.5rem_0px_2rem_2rem]",
        "xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(5.5rem,1fr)_2rem_13rem_5.5rem_4.5rem_2rem_2rem]",
        nested && "pl-10",
        // The one row that is still happening. A 5% tint was not enough to
        // find it in a day of twelve rows, so it also gets an accent edge and
        // a live badge — three signals rather than one, and the badge carries
        // a word, so the row never relies on colour alone.
        //
        // `destructive`, because that is already this app's "live" colour: the
        // header's running dot and the Stop button both use it, while
        // `primary` is near-black in the light theme and reads as "selected".
        //
        // The edge is a pseudo-element rather than a border, and the badge
        // lives INSIDE the description cell: both column templates above name
        // exactly eleven tracks, so a twelfth grid item — or four pixels of
        // border — would knock this row's columns out of line with the rest.
        running &&
          "relative bg-destructive/[0.06] hover:bg-destructive/10 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-destructive"
      )}
      data-testid="entry-row"
      data-entry-id={entry.id}
      data-running={running ? "true" : "false"}
      data-syncing={syncing ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-2 min-[1140px]:w-full">
        {running ? (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
            data-testid="entry-running-badge"
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-destructive" />
            </span>
            {t("row.running")}
          </span>
        ) : null}

        {editingDescription ? (
          <Input
            value={draft}
            autoFocus
            aria-label={tc("fields.description")}
            className="h-8 min-w-0 flex-1"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDescription}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDescription();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(entry.description);
                setEditingDescription(false);
              }
            }}
            data-testid="entry-description-input"
          />
        ) : (
          <button
            type="button"
            disabled={syncing}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
              entry.description.trim() === "" && "text-muted-foreground italic"
            )}
            onClick={() => {
              setDraft(entry.description);
              setEditingDescription(true);
            }}
            data-testid="entry-description"
          >
            {entry.description.trim() === ""
              ? t("row.addDescription")
              : entry.description}
          </button>
        )}
      </div>

      {/* Same coupled control as the tracker bar, the dialogs and the
          calendar: filing a past entry under a project that does not exist
          yet is exactly when you need to make one, and sending that trip to
          the Projects screen loses the row you were fixing. `contents` keeps
          project, client and task as three grid items of THIS row, so they
          stay in the shared column template. */}
      <ProjectTaskPicker
        value={fields}
        onChange={applyFields}
        disabled={syncing}
        size="sm"
        bare
        layout="contents"
        controlClassName="h-8 w-full min-w-0 max-w-48 min-[1140px]:max-w-none"
        testIdPrefix="entry"
      />

      {/* The chips ARE the trigger, so tagging costs one click and the row
          keeps its height however many tags it carries — the overflow
          collapses into "+N" rather than wrapping onto a second line. */}
      <TagPicker
        value={entry.tagIds}
        disabled={syncing}
        maxChips={2}
        placeholder=""
        className="h-8 w-full min-w-0 max-w-44 border-0 px-2 shadow-none min-[1140px]:max-w-none"
        testId="entry-tags"
        onChange={(ids) => mutations.updateEntry({ id: entry.id, tagIds: ids })}
      />

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 cap-touch"
        disabled={syncing}
        aria-label={
          entry.billable ? tc("fields.billable") : t("fields.notBillable")
        }
        aria-pressed={entry.billable}
        onClick={() =>
          mutations.updateEntry({ id: entry.id, billable: !entry.billable })
        }
        data-testid="entry-billable"
        data-billable={entry.billable ? "true" : "false"}
      >
        <BillableGlyph billable={entry.billable} />
      </Button>

      <div className="flex min-w-0 items-center gap-1 min-[1140px]:w-full">
        <TimeField
          value={entry.start}
          timeFormat={format.timeFormat}
          timeZone={entryZone}
          disabled={syncing}
          aria-label={t("fields.startTime")}
          testId="entry-start"
          onCommit={handleStartCommit}
        />
        <span className="text-muted-foreground">–</span>
        {entry.end === null ? (
          <span
            className="w-[4.5rem] text-center font-mono text-sm text-muted-foreground tabular-nums"
            data-testid="entry-end"
          >
            {t("row.now")}
          </span>
        ) : (
          <TimeField
            value={entry.end}
            timeFormat={format.timeFormat}
            timeZone={entryZone}
            disabled={syncing}
            aria-label={t("fields.endTime")}
            testId="entry-end"
            onCommit={handleEndCommit}
          />
        )}
        {/* Without this an entry reads "23:30 – 00:30" and looks like it ran
            backwards, with nothing to say the end is on the next day. */}
        {spansDayBoundaryInZone(entry.start, entry.end, entryZone) ? (
          <span
            className="ml-1 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground"
            title={t("row.nextDayTitle")}
            data-testid="entry-next-day"
          >
            {t("row.nextDay")}
          </span>
        ) : null}
        {/* Only shown when the entry was recorded somewhere else — otherwise
            every row would carry a redundant label for the zone you are in. */}
        {foreignZone ? (
          <span
            className="ml-1 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground"
            title={t("row.recordedIn", { zone: entryZone })}
            data-testid="entry-zone"
          >
            {zoneLabel(entryZone)}
          </span>
        ) : null}
      </div>

      {running ? (
        <LiveDuration
          baseSec={0}
          matchEntryId={entry.id}
          className="w-24 text-right text-sm font-semibold min-[1140px]:w-full"
          testId="entry-duration"
        />
      ) : (
        <DurationInput
          value={entry.durationSec}
          format={format.durationFormat}
          disabled={syncing}
          aria-label={tc("fields.duration")}
          testId="entry-duration"
          className="h-8 w-24 min-[1140px]:w-full"
          onCommit={handleDurationCommit}
        />
      )}

      <span
        className="hidden w-20 overflow-hidden text-right text-sm text-muted-foreground tabular-nums sm:inline min-[1140px]:block min-[1140px]:w-full"
        data-testid="entry-amount"
      >
        {entry.hourlyRate === null || entry.amount === null
          ? ""
          : format.money(entry.amount)}
      </span>

      {/* The running entry gets Stop, not Continue. "Continuing" something
          already running stops it and starts an identical copy, which silently
          shreds one stretch of work into a pile of few-second fragments. */}
      {running ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 cap-touch bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
          aria-label={t("row.stop")}
          onClick={() => mutations.stopTimer()}
          data-testid="entry-stop"
        >
          <Square />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 cap-touch text-primary"
          aria-label={t("row.continue")}
          onClick={() => mutations.continueEntry(entry)}
          data-testid="entry-continue"
        >
          <Play />
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 cap-touch"
            aria-label={t("row.actions")}
            data-testid="entry-menu"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Pinning is what promotes an entry from "recently tracked" to
              "always one click away". A temp entry is excluded: its project
              and task are real, but pinning something the server has not seen
              invites a pin that outlives an entry the replay may still
              reject. */}
          {pinned ? (
            <DropdownMenuItem
              onSelect={() => {
                if (favoriteId !== null) quickStarts.unpin(favoriteId);
              }}
              data-testid="entry-menu-unpin"
            >
              <PinOff /> {t("row.unpin")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={syncing}
              onSelect={() => quickStarts.pin(quick)}
              data-testid="entry-menu-pin"
            >
              <Pin /> {t("row.pin")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => mutations.duplicateEntry(entry)}
            data-testid="entry-menu-duplicate"
          >
            <Copy /> {tc("actions.duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={syncing}
            onSelect={() => onEdit(entry)}
            data-testid="entry-menu-edit"
          >
            <Pencil /> {tc("actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => mutations.removeEntry(entry)}
            data-testid="entry-menu-delete"
          >
            <Trash2 /> {tc("actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Memoised: a running timer re-renders the list once a second and history
 * pages in fifty rows at a time. With `useEntryMutations` and `useQuickStarts`
 * both handing back stable objects, an unchanged row does no work on either.
 */
export const EntryRow = React.memo(EntryRowImpl);
EntryRow.displayName = "EntryRow";
