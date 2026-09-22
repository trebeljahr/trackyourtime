"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { deviceTimeZone, type EntryFields } from "@starter/core";
import {
  dayKeyInZone,
  parseTimeOfDay,
  type DetailedEntry,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PopoverContent } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { useWriteThroughEntryFields } from "@/components/entry-fields/use-entry-fields";
import { movedStartDay } from "@/components/tracker/use-entry-editor";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import type { CalendarActions } from "./use-calendar-entries";

export type EntryEditPopoverProps = {
  entry: DetailedEntry;
  actions: CalendarActions;
  /** Live end used for the running entry, which has `end === null`. */
  nowMs: number;
  onClose: () => void;
};

/**
 * The inline editor opened by clicking a block. Every field commits on its
 * own (blur / Enter / toggle) so the popover needs no save button.
 */
export function EntryEditPopover({
  entry,
  actions,
  nowMs,
  onClose,
}: EntryEditPopoverProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("calendar");
  const tc = useT("common");
  const isRunning = entry.end === null;
  const endIso = entry.end ?? new Date(nowMs).toISOString();

  const commitFields = React.useCallback(
    (patch: Partial<EntryFields>): void => {
      actions.update(entry.id, patch);
    },
    [actions, entry.id]
  );
  const { fields, onChange, commitDescription } = useWriteThroughEntryFields(
    entry,
    commitFields
  );

  const [start, setStart] = React.useState(() => format.clock(entry.start));
  const [end, setEnd] = React.useState(() => format.clock(endIso));

  // Adopt sync/drag updates that land while the popover is open.
  const [lastEntry, setLastEntry] = React.useState(entry);
  if (lastEntry !== entry) {
    setLastEntry(entry);
    setStart(format.clock(entry.start));
    setEnd(format.clock(endIso));
  }

  const durationSec = format.entryDuration(entry, nowMs);

  // The day is read and re-anchored in the zone the entry was RECORDED in,
  // like the edit dialog: moving "23:30 Berlin" to another day keeps it at
  // 23:30 Berlin whoever is editing. `movedStartDay` carries the end along by
  // the same delta, so the block keeps its length; a running entry has no end
  // to carry, and stays running.
  const entryZone = entry.timeZone ?? deviceTimeZone();
  const dayKey = dayKeyInZone(Date.parse(entry.start), entryZone);
  const commitDay = (next: string): void => {
    if (next === "" || next === dayKey) return;
    const moved = movedStartDay(
      { start: entry.start, end: endIso },
      next,
      entryZone
    );
    if (moved.start === entry.start) return;
    actions.update(
      entry.id,
      isRunning ? { start: moved.start } : { start: moved.start, end: moved.end }
    );
  };

  const commitTime = (field: "start" | "end", raw: string): void => {
    const anchor = field === "start" ? entry.start : endIso;
    const iso = parseTimeOfDay(raw, anchor);
    if (iso === null) {
      toast.error(t("edit.invalidTime", { value: raw }));
      if (field === "start") setStart(format.clock(entry.start));
      else setEnd(format.clock(endIso));
      return;
    }

    const nextStart = field === "start" ? iso : entry.start;
    const nextEnd = field === "end" ? iso : endIso;
    if (Date.parse(nextEnd) <= Date.parse(nextStart)) {
      toast.error(t("create.endBeforeStart"));
      if (field === "start") setStart(format.clock(entry.start));
      else setEnd(format.clock(endIso));
      return;
    }

    if (field === "start") {
      if (iso === entry.start) return;
      actions.update(entry.id, { start: iso });
      return;
    }
    if (isRunning) {
      // Stopping a running entry from the calendar is an explicit edit.
      actions.update(entry.id, { end: iso });
      return;
    }
    if (iso === entry.end) return;
    actions.update(entry.id, { end: iso });
  };

  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={8}
      collisionPadding={8}
      className="w-80 space-y-3"
      data-testid="calendar-edit-popover"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
    >
      {/* Billable lives with the duration below, next to the money it
          decides, so it is excluded here rather than rendered twice. */}
      <EntryFieldsEditor
        value={fields}
        onChange={onChange}
        fields={["description", "projectTask", "tags"]}
        descriptionPlaceholder={t("create.descriptionPlaceholder")}
        onDescriptionCommit={commitDescription}
        idPrefix={`calendar-edit-${entry.id}`}
        testIdPrefix="calendar-edit"
      />

      {/* The grid can move a block within the week it shows; the day field is
          how it leaves that week — the calendar's version of the dialog's
          start date, without a Save button because nothing else here has one. */}
      <div className="space-y-1.5">
        <Label htmlFor={`calendar-edit-date-${entry.id}`}>{tc("fields.date")}</Label>
        <Input
          id={`calendar-edit-date-${entry.id}`}
          type="date"
          value={dayKey}
          className="tabular-nums"
          onChange={(event) => {
            commitDay(event.target.value);
          }}
          data-testid="calendar-edit-date"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`calendar-edit-start-${entry.id}`}>
            {tc("fields.start")}
          </Label>
          <Input
            id={`calendar-edit-start-${entry.id}`}
            data-testid="calendar-edit-start"
            value={start}
            className="tabular-nums"
            onChange={(event) => {
              setStart(event.target.value);
            }}
            onBlur={() => {
              commitTime("start", start);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTime("start", start);
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`calendar-edit-end-${entry.id}`}>
            {isRunning ? t("edit.endStopsTimer") : tc("fields.end")}
          </Label>
          <Input
            id={`calendar-edit-end-${entry.id}`}
            data-testid="calendar-edit-end"
            value={end}
            className="tabular-nums"
            onChange={(event) => {
              setEnd(event.target.value);
            }}
            onBlur={() => {
              commitTime("end", end);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTime("end", end);
              }
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id={`calendar-edit-billable-${entry.id}`}
            data-testid="calendar-edit-billable"
            checked={entry.billable}
            onCheckedChange={(billable) => {
              actions.update(entry.id, { billable });
            }}
          />
          <Label htmlFor={`calendar-edit-billable-${entry.id}`}>
            {tc("fields.billable")}
          </Label>
        </div>
        <span
          className="text-muted-foreground text-sm tabular-nums"
          data-testid="calendar-edit-duration"
        >
          {format.duration(durationSec)}
        </span>
      </div>

      <Separator />

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          data-testid="calendar-edit-delete"
          onClick={() => {
            actions.remove(entry.id);
            onClose();
          }}
        >
          <Trash2 className="size-4" />
          {tc("actions.delete")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="calendar-edit-close"
          onClick={onClose}
        >
          {tc("actions.done")}
        </Button>
      </div>
    </PopoverContent>
  );
}
