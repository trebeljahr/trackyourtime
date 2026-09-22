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

/**
 * The second line's pickers: compact left-aligned text that reads as a
 * caption until pointed at. A combobox trigger's last child is its chevron.
 */
const META_CONTROL =
  "h-7 w-auto min-w-0 shrink justify-start px-2 text-xs text-muted-foreground hover:text-foreground [&>svg:last-child]:opacity-0 group-hover/row:[&>svg:last-child]:opacity-50 focus-visible:[&>svg:last-child]:opacity-50";

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
        // Two lines. What the work WAS gets the whole left side to itself, so
        // a long description is no longer cut to "Create Tra…" by eight
        // columns sharing one line; what it was filed under sits quieter
        // underneath. The right side keeps fixed widths, so times, durations
        // and amounts still line up down the list.
        "group/row flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-muted/40 sm:flex-nowrap",
        nested && "pl-10",
        // The list leaves the running entry to the tracker bar, so this is a
        // fallback: if one ever reaches a row it still says so, with a word
        // and an edge rather than colour alone.
        running &&
          "relative bg-destructive/[0.06] hover:bg-destructive/10 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-destructive"
      )}
      data-testid="entry-row"
      data-entry-id={entry.id}
      data-running={running ? "true" : "false"}
      data-syncing={syncing ? "true" : "false"}
    >
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex min-w-0 items-center gap-2">
          {running ? (
            <span
              className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
              data-testid="entry-running-badge"
            >
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
                // Two lines before clipping, not one: the description has the
              // whole left side now, and a long one is the thing this row
              // exists to show.
              "line-clamp-2 min-w-0 flex-1 break-words rounded px-2 py-0.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
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
            yet is exactly when you need to make one. The chevrons show on hover
            and focus only — on every row at once they were most of the noise. */}
        <div className="flex min-w-0 flex-nowrap items-center">
          <ProjectTaskPicker
            value={fields}
            onChange={applyFields}
            disabled={syncing}
            size="sm"
            bare
            layout="contents"
            controlClassName={META_CONTROL}
            testIdPrefix="entry"
          />

          {/* The chips ARE the trigger, so tagging costs one click and the row
              keeps its height however many tags it carries — the overflow
              collapses into "+N" rather than wrapping. */}
          <TagPicker
            value={entry.tagIds}
            disabled={syncing}
            maxChips={2}
            placeholder=""
            className="h-7 w-auto shrink-0 border-0 px-2 text-xs shadow-none"
            testId="entry-tags"
            onChange={(ids) => mutations.updateEntry({ id: entry.id, tagIds: ids })}
          />
        </div>
      </div>

      {/* Below `sm` the row wraps: the description block takes the line and
          the controls follow underneath, wrapping among themselves. */}
      <div className="flex w-full flex-wrap items-center gap-1 sm:ml-auto sm:w-auto sm:shrink-0 sm:flex-nowrap">
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

        <div className="flex w-[13.5rem] items-center gap-1">
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
            className="w-24 text-right text-sm font-semibold"
            testId="entry-duration"
          />
        ) : (
          <DurationInput
            value={entry.durationSec}
            format={format.durationFormat}
            disabled={syncing}
            aria-label={tc("fields.duration")}
            testId="entry-duration"
            className="h-8 w-24"
            onCommit={handleDurationCommit}
          />
        )}

        <span
          className="hidden w-20 overflow-hidden text-right text-sm text-muted-foreground tabular-nums sm:inline"
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

        {/* The dialog is the only place the row's DATE can change, and a menu
            item three clicks away was where people stopped looking for it. The
            menu keeps its Edit item for keyboard and phone users. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 cap-touch"
          disabled={syncing}
          aria-label={tc("actions.edit")}
          title={tc("actions.edit")}
          onClick={() => onEdit(entry)}
          data-testid="entry-edit"
        >
          <Pencil />
        </Button>

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
