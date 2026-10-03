"use client";

import * as React from "react";
import { addDaysToKey, dayKeyInZone, withDayInZone } from "@starter/shared";
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
import { useEntrySubmission } from "@/components/tracker/use-entry-submission";
import type { EntryMutationResult } from "@/lib/entry-mutation-result";
import { TimeField } from "@/components/tracker/time-field";
import { movedEndDay, movedStartDay } from "@/components/tracker/use-entry-editor";
import type {
  EntryMutations,
  ManualEntryArgs,
} from "@/components/tracker/use-entry-mutations";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";

const isValidDayKey = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  dayKeyInZone(Date.parse(`${value}T00:00:00.000Z`), "UTC") === value;

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
  onAdd?: (args: ManualEntryArgs) => Promise<EntryMutationResult>;
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
  const [startDateValid, setStartDateValid] = React.useState(true);
  const [endDateValid, setEndDateValid] = React.useState(true);
  const [wasOpen, setWasOpen] = React.useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setRange(seedRange ?? defaultManualRange());
      setStartDateValid(true);
      setEndDateValid(true);
    }
  }

  const seconds = Math.max(
    0,
    Math.round((Date.parse(range.end) - Date.parse(range.start)) / 1000)
  );

  const submission = useEntrySubmission(open, () => onOpenChange(false));

  const add = (): void => {
    if (!startDateValid || !endDateValid || seconds <= 0) return;
    const args: ManualEntryArgs = {
      ...fields,
      start: range.start,
      end: range.end,
    };
    submission.submit(() => onAdd !== undefined ? onAdd(args) : mutations.createManualEntry(args));
  };

  const startDay = dayKeyInZone(Date.parse(range.start), zone);
  const endDay = dayKeyInZone(Date.parse(range.end), zone);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) submission.dismiss(); }}>
      <DialogContent data-testid="manual-entry-dialog" showCloseButton={!submission.pending}>
        <DialogHeader>
          <DialogTitle>{t("manualDialog.title")}</DialogTitle>
          <DialogDescription>{t("manualDialog.description")}</DialogDescription>
        </DialogHeader>

        <fieldset disabled={submission.pending} className="min-w-0 space-y-4" aria-busy={submission.pending}>
          <EntryFieldsEditor
            disabled={submission.pending}
            value={fields}
            onChange={setFields}
            autoFocus
            onSubmit={add}
            idPrefix="manual-entry"
            testIdPrefix="manual-entry"
          />

          <div className="space-y-2">
            <Label htmlFor="manual-entry-date">{t("fields.startDate")}</Label>
            <Input
              id="manual-entry-date"
              type="date"
              value={dayKeyInZone(Date.parse(range.start), zone)}
              onChange={(event) => {
                const day = event.target.value;
                if (!isValidDayKey(day)) {
                  setStartDateValid(false);
                  return;
                }
                setStartDateValid(true);
                setEndDateValid(true);
                // Moving the date carries the end with it, so the block keeps
                // its length instead of silently stretching.
                setRange((current) => movedStartDay(current, day, zone));
              }}
              data-testid="manual-entry-date"
              aria-invalid={!startDateValid || undefined}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="manual-entry-end-date">{t("fields.endDate")}</Label>
            <Input
              id="manual-entry-end-date"
              type="date"
              value={endDay}
              min={startDay}
              onChange={(event) => {
                const day = event.target.value;
                if (!isValidDayKey(day) || day < startDay) {
                  setEndDateValid(false);
                  return;
                }
                const next = movedEndDay(range, day, zone);
                if (Date.parse(next.end) <= Date.parse(range.start)) {
                  setEndDateValid(false);
                  return;
                }
                setEndDateValid(true);
                setRange(next);
              }}
              data-testid="manual-entry-end-date"
              aria-invalid={!endDateValid || undefined}
              aria-describedby="manual-entry-end-date-hint"
              required
            />
            <p
              className="text-xs text-muted-foreground"
              id="manual-entry-end-date-hint"
              role={endDateValid ? undefined : "alert"}
            >
              {endDateValid
                ? t("manualDialog.endDateHint")
                : t("manualDialog.invalidEndDate")}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>{tc("fields.start")}</Label>
              <TimeField
                value={range.start}
                timeZone={zone}
                timeFormat={format.timeFormat}
                aria-label={t("fields.startTime")}
                testId="manual-entry-start"
                onCommit={(iso) => {
                  setEndDateValid(true);
                  setRange((current) => {
                    let end = current.end;
                    const currentStartDay = dayKeyInZone(
                      Date.parse(current.start),
                      zone
                    );
                    const currentEndDay = dayKeyInZone(
                      Date.parse(current.end),
                      zone
                    );
                    if (
                      Date.parse(end) <= Date.parse(iso) &&
                      currentEndDay === currentStartDay
                    ) {
                      end = withDayInZone(
                        end,
                        addDaysToKey(currentStartDay, 1),
                        zone
                      );
                    }
                    return { start: iso, end };
                  });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>{tc("fields.end")}</Label>
              <TimeField
                value={range.end}
                timeZone={zone}
                timeFormat={format.timeFormat}
                aria-label={t("fields.endTime")}
                testId="manual-entry-end"
                onCommit={(iso) => {
                  setEndDateValid(true);
                  setRange((current) => {
                    let end = iso;
                    const currentStartDay = dayKeyInZone(
                      Date.parse(current.start),
                      zone
                    );
                    const currentEndDay = dayKeyInZone(
                      Date.parse(current.end),
                      zone
                    );
                    if (
                      Date.parse(end) <= Date.parse(current.start) &&
                      currentEndDay === currentStartDay
                    ) {
                      end = withDayInZone(
                        end,
                        addDaysToKey(currentStartDay, 1),
                        zone
                      );
                    }
                    return { start: current.start, end };
                  });
                }}
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
                onCommit={(next) => {
                  setEndDateValid(true);
                  setRange((current) => ({
                    start: current.start,
                    end: new Date(
                      Date.parse(current.start) + Math.max(60, next) * 1000
                    ).toISOString(),
                  }));
                }}
              />
            </div>
          </div>
        </fieldset>

        {submission.error ? <p role="alert" className="text-sm text-destructive" data-testid="manual-entry-error">{submission.error} {t("mutations.draftKept")}</p> : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={submission.dismiss}
            disabled={submission.pending}
            data-testid="manual-entry-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={add}
            disabled={submission.pending || !startDateValid || !endDateValid || seconds <= 0}
            data-testid="manual-entry-add"
          >
            {tc("actions.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
