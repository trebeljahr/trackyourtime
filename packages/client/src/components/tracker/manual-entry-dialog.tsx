"use client";

import * as React from "react";
import { dayKeyInZone, rollEndAfterStart, withDayInZone } from "@starter/shared";
import {
  defaultManualRange,
  deviceTimeZone,
  entryFieldsFrom,
} from "@starter/core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DurationInput } from "@/components/duration-input";
import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { useEntryFields } from "@/components/entry-fields/use-entry-fields";
import { TimeField } from "@/components/tracker/time-field";
import type {
  EntryMutations,
  ManualEntryArgs,
} from "@/components/tracker/use-entry-mutations";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";

const clampEnd = (start: string, end: string): string =>
  Date.parse(end) > Date.parse(start)
    ? end
    : new Date(Date.parse(start) + 60_000).toISOString();

/** What the tracker bar hands over when the dialog opens. */
export type ManualEntrySeed = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  tagIds: string[];
};

export type ManualEntryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill, so a half-typed composer is not thrown away by opening this. */
  seed: ManualEntrySeed;
  mutations: EntryMutations;
  /** The block to open on, as ISO instants. Omitted: the default recent block. */
  range?: { start: string; end: string };
  /**
   * Called with the entry instead of `mutations.createManualEntry` — for a
   * caller that checks the block before creating it (an activity suggestion).
   */
  onAdd?: (args: ManualEntryArgs) => void;
};

/**
 * Log a block of time that was never timed.
 *
 * This used to be a second mode of the tracker bar, reached through a `+`
 * that sat next to the timer-mode button and looked like part of the timer.
 * Logging past work is its own action, not a state the bar can be left
 * stuck in, so it gets its own button and its own modal — which also has
 * the room for a date, something the inline row never had.
 */
export function ManualEntryDialog({
  open,
  onOpenChange,
  seed,
  mutations,
  range: seedRange,
  onAdd,
}: ManualEntryDialogProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("tracker");
  const tc = useT("common");
  const zone = deviceTimeZone();

  // Reseed on each open rather than in an effect, so the very first paint
  // already shows the composer's values instead of the previous block's.
  // Both seeds are read during render — by `useEntryFields` when `open`
  // changes, and by the reopen branch below — so closing over this render's
  // props is exactly what a latest-value ref would have held.
  const { fields, setFields } = useEntryFields(
    () => entryFieldsFrom(seed),
    open
  );

  const [range, setRange] = React.useState(defaultManualRange);
  const [wasOpen, setWasOpen] = React.useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRange(seedRange ?? defaultManualRange());
  }

  const seconds = Math.max(
    0,
    Math.round((Date.parse(range.end) - Date.parse(range.start)) / 1000)
  );

  const add = React.useCallback((): void => {
    // Roll a midnight-crossing end forward rather than clamping it: 23:30 to
    // 00:30 is an hour of work, and clamping would throw that away.
    const args: ManualEntryArgs = {
      ...fields,
      start: range.start,
      end: rollEndAfterStart(range.start, range.end),
    };
    if (onAdd !== undefined) onAdd(args);
    else mutations.createManualEntry(args);
    onOpenChange(false);
  }, [fields, mutations, onAdd, onOpenChange, range]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="manual-entry-dialog">
        <DialogHeader>
          <DialogTitle>{t("manualDialog.title")}</DialogTitle>
          <DialogDescription>{t("manualDialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <EntryFieldsEditor
            value={fields}
            onChange={setFields}
            autoFocus
            onSubmit={add}
            idPrefix="manual-entry"
            testIdPrefix="manual-entry"
          />

          <div className="space-y-2">
            <Label htmlFor="manual-entry-date">{tc("fields.date")}</Label>
            <Input
              id="manual-entry-date"
              type="date"
              value={dayKeyInZone(Date.parse(range.start), zone)}
              onChange={(event) => {
                // Moving the date carries the end with it, so the block keeps
                // its length instead of silently stretching.
                setRange((current) => {
                  const start = withDayInZone(
                    current.start,
                    event.target.value,
                    zone
                  );
                  const delta = Date.parse(start) - Date.parse(current.start);
                  return {
                    start,
                    end: new Date(Date.parse(current.end) + delta).toISOString(),
                  };
                });
              }}
              data-testid="manual-entry-date"
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>{tc("fields.start")}</Label>
              <TimeField
                value={range.start}
                timeFormat={format.timeFormat}
                aria-label={t("fields.startTime")}
                testId="manual-entry-start"
                onCommit={(iso) =>
                  setRange((current) => ({
                    start: iso,
                    end: clampEnd(iso, current.end),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>{tc("fields.end")}</Label>
              <TimeField
                value={range.end}
                timeFormat={format.timeFormat}
                aria-label={t("fields.endTime")}
                testId="manual-entry-end"
                onCommit={(iso) =>
                  setRange((current) => ({
                    start: current.start,
                    end: clampEnd(current.start, iso),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>{tc("fields.duration")}</Label>
              <DurationInput
                value={seconds}
                format={format.durationFormat}
                aria-label={tc("fields.duration")}
                testId="manual-entry-duration"
                className="w-28"
                onCommit={(next) =>
                  setRange((current) => ({
                    start: current.start,
                    end: new Date(
                      Date.parse(current.start) + Math.max(60, next) * 1000
                    ).toISOString(),
                  }))
                }
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="manual-entry-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button type="button" onClick={add} data-testid="manual-entry-add">
            {tc("actions.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
