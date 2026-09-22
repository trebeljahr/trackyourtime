"use client";

import * as React from "react";
import { emptyEntryFields } from "@starter/core";
import { parseTimeOfDay } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PopoverContent } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { useEntryFields } from "@/components/entry-fields/use-entry-fields";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { formatDayLabel, useFormatSettings } from "@/lib/format";
import {
  MINUTES_PER_DAY,
  MIN_DURATION_MINUTES,
  isoAtMinute,
  type MinuteRange,
} from "./calendar-math";
import type { CalendarActions } from "./use-calendar-entries";

export type EntryCreatePopoverProps = {
  /** The local day the draft sits on. */
  day: Date;
  /** The draft's current span, live while its edges are being dragged. */
  range: MinuteRange;
  onRangeChange: (range: MinuteRange) => void;
  actions: CalendarActions;
  /** The draft block: a press on it (a drag of its edges) must not close this. */
  draftRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * The editor anchored to a draft block. Start and end mirror the block —
 * dragging an edge updates the fields, typing a time moves the edge — and
 * nothing is written until Create. Cancel, Escape or a click elsewhere on
 * the grid discard the draft.
 */
export function EntryCreatePopover({
  day,
  range,
  onRangeChange,
  actions,
  draftRef,
  onClose,
}: EntryCreatePopoverProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("calendar");
  const tc = useT("common");

  const { fields, setFields } = useEntryFields(emptyEntryFields, null);

  const startIso = isoAtMinute(day, range.startMin);
  const endIso = isoAtMinute(day, range.endMin);
  const [start, setStart] = React.useState(() => format.clock(startIso));
  const [end, setEnd] = React.useState(() => format.clock(endIso));

  // Adopt a drag of the block's edges while the popover is open, without
  // clobbering a time that is being typed for the *other* edge.
  const [lastRange, setLastRange] = React.useState(range);
  if (lastRange.startMin !== range.startMin || lastRange.endMin !== range.endMin) {
    setLastRange(range);
    if (lastRange.startMin !== range.startMin) setStart(format.clock(startIso));
    if (lastRange.endMin !== range.endMin) setEnd(format.clock(endIso));
  }

  const dayStartMs = Date.parse(isoAtMinute(day, 0));

  const commitTime = (field: "start" | "end", raw: string): void => {
    const revert = (): void => {
      if (field === "start") setStart(format.clock(startIso));
      else setEnd(format.clock(endIso));
    };
    const iso = parseTimeOfDay(raw, startIso);
    const minute = iso === null ? NaN : (Date.parse(iso) - dayStartMs) / 60_000;
    if (!Number.isFinite(minute) || minute < 0 || minute > MINUTES_PER_DAY) {
      toast.error(t("edit.invalidTime", { value: raw }));
      revert();
      return;
    }
    const next: MinuteRange =
      field === "start"
        ? { startMin: minute, endMin: range.endMin }
        : { startMin: range.startMin, endMin: minute };
    if (next.endMin - next.startMin < MIN_DURATION_MINUTES) {
      toast.error(t("create.endBeforeStart"));
      revert();
      return;
    }
    if (next.startMin === range.startMin && next.endMin === range.endMin) {
      revert();
      return;
    }
    onRangeChange(next);
  };

  const submit = (): void => {
    actions.create({
      ...fields,
      start: startIso,
      end: endIso,
    });
    onClose();
  };

  const durationSec = Math.max(0, (range.endMin - range.startMin) * 60);

  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={8}
      collisionPadding={8}
      updatePositionStrategy="always"
      className="w-80 max-h-[var(--radix-popover-content-available-height)] space-y-3 overflow-y-auto"
      data-testid="calendar-create-popover"
      onOpenAutoFocus={(event) => {
        // The description takes focus itself; Radix would pick the first
        // tabbable, which is the same field — but only after the animation.
        event.preventDefault();
      }}
      onInteractOutside={(event) => {
        // A press on the draft block is a drag of its edges or a move, not
        // a dismissal — the grid owns that gesture and the popover follows.
        const target = event.target;
        if (target instanceof Node && draftRef.current?.contains(target)) {
          event.preventDefault();
        }
      }}
    >
      <div className="text-muted-foreground text-xs">
        {formatDayLabel(startIso, format.locale)}
      </div>

      <EntryFieldsEditor
        value={fields}
        onChange={setFields}
        fields={["description", "projectTask", "tags"]}
        autoFocus
        descriptionPlaceholder={t("create.descriptionPlaceholder")}
        onSubmit={submit}
        idPrefix="calendar-create"
        testIdPrefix="calendar-create"
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="calendar-create-start">{tc("fields.start")}</Label>
          <Input
            id="calendar-create-start"
            data-testid="calendar-create-start"
            className="tabular-nums"
            value={start}
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
          <Label htmlFor="calendar-create-end">{tc("fields.end")}</Label>
          <Input
            id="calendar-create-end"
            data-testid="calendar-create-end"
            className="tabular-nums"
            value={end}
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
            id="calendar-create-billable"
            data-testid="calendar-create-billable"
            checked={fields.billable}
            onCheckedChange={(billable) => {
              setFields({ ...fields, billable });
            }}
          />
          <Label htmlFor="calendar-create-billable">{tc("fields.billable")}</Label>
        </div>
        <span
          className="text-muted-foreground text-sm tabular-nums"
          data-testid="calendar-create-duration"
        >
          {format.duration(durationSec)}
        </span>
      </div>

      <Separator />

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-testid="calendar-create-cancel"
          onClick={onClose}
        >
          {tc("actions.cancel")}
        </Button>
        <Button size="sm" data-testid="calendar-create-submit" onClick={submit}>
          {t("create.submit")}
        </Button>
      </div>
    </PopoverContent>
  );
}
