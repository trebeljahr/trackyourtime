"use client";

import * as React from "react";
import {
  dayKeyInZone,
  isSameZone,
  rollEndAfterStart,
  withDayInZone,
  type DayKey,
  type DetailedEntry,
} from "@starter/shared";
import {
  deviceTimeZone,
  emptyEntryFields,
  entryFieldsFrom,
  type EntryFields,
} from "@starter/core";

import { useEntryFields } from "@/components/entry-fields/use-entry-fields";
import { useEntrySubmission } from "@/components/tracker/use-entry-submission";
import type { EntryMutationResult } from "@/lib/entry-mutation-result";
import type { UpdateEntryArgs } from "@/components/tracker/use-entry-mutations";

/**
 * The rules that decide what editing one entry actually writes.
 *
 * These lived inside `entry-edit-dialog.tsx`, reachable only through a DOM,
 * which made them both untestable and re-implementable — and they are the
 * subtlest correctness rules in the app. They are pure functions here, with a
 * hook on top that holds the buffered state, so any other edit surface (a
 * phone sheet, a popover) inherits them instead of writing them again.
 *
 * Four rules, each of which destroys data when it is got wrong:
 *
 * - **Re-anchoring a date happens in the ENTRY's zone, not the editor's.**
 *   Moving "23:30 Berlin" to another day must keep it at 23:30 Berlin even
 *   when the person editing is in Tokyo. `withDayInZone` does exactly that;
 *   doing the arithmetic in local time silently shifts the entry by the offset
 *   between the two zones.
 * - **Moving the start day carries the end with it**, by the same delta, so
 *   the entry keeps its length instead of silently stretching across the gap.
 * - **A midnight-crossing end rolls forward rather than clamping.** 23:30 to
 *   00:30 is an hour of work; clamping to start + 1 minute threw it away.
 * - **A running entry keeps running.** `end` stays `null` unless the entry
 *   already had one, so saving a description on a live timer cannot stop it.
 */

/** The two instants an editor is buffering, as ISO strings. */
export type EntryTimes = {
  start: string;
  end: string;
};

/** Just enough of an entry to decide what a save writes. */
export type EditableEntry = {
  id: string;
  end: string | null;
};

/**
 * Move the start onto another calendar day, carrying the end along.
 *
 * The end moves by the same number of milliseconds rather than being
 * re-anchored itself, which is what keeps the duration — including a
 * DST-shifted one — exactly as it was. Re-anchoring both independently would
 * stretch or shrink any entry crossing a transition.
 */
export const movedStartDay = (
  times: EntryTimes,
  dayKey: DayKey,
  timeZone: string
): EntryTimes => {
  const start = withDayInZone(times.start, dayKey, timeZone);
  const delta = Date.parse(start) - Date.parse(times.start);
  return {
    start,
    end: new Date(Date.parse(times.end) + delta).toISOString(),
  };
};

/** Move the end onto another calendar day, keeping its clock time in `timeZone`. */
export const movedEndDay = (
  times: EntryTimes,
  dayKey: DayKey,
  timeZone: string
): EntryTimes => ({
  start: times.start,
  end: withDayInZone(times.end, dayKey, timeZone),
});

/** Whole seconds between the two instants, never negative. */
export const editorDurationSeconds = (times: EntryTimes): number =>
  Math.max(0, Math.round((Date.parse(times.end) - Date.parse(times.start)) / 1000));

/** The end that gives the entry this many seconds. One minute is the floor. */
export const endForDurationSeconds = (start: string, seconds: number): string =>
  new Date(Date.parse(start) + Math.max(60, seconds) * 1000).toISOString();

/**
 * What saving the editor writes.
 *
 * `rollEndAfterStart` resolves an end that landed on or before its start, and
 * a running entry (`end === null`) is left running.
 */
export const entryUpdateFrom = (
  entry: EditableEntry,
  fields: EntryFields,
  times: EntryTimes
): UpdateEntryArgs => {
  // Roll a midnight-crossing end forward rather than clamping it: an entry
  // from 23:30 to 00:30 is an hour of work, and clamping threw that away.
  const safeEnd = rollEndAfterStart(times.start, times.end);

  return {
    id: entry.id,
    ...fields,
    start: times.start,
    // A running entry keeps running unless it already had an end.
    end: entry.end === null ? null : safeEnd,
  };
};

/** Everything an entry editor UI needs, with none of the rules left in it. */
export type EntryEditor = {
  fields: EntryFields;
  setFields: (next: EntryFields) => void;
  start: string;
  end: string;
  setStart: (next: string) => void;
  setEnd: (next: string) => void;
  /** The zone the entry was RECORDED in — everything is read and written in it. */
  entryZone: string;
  /** True when that zone is not the device's, so the UI can say so. */
  foreignZone: boolean;
  /** Whether the entry is still running, so end and duration are not editable. */
  isRunning: boolean;
  seconds: number;
  startDayKey: DayKey;
  endDayKey: DayKey;
  changeStartDay: (dayKey: DayKey) => void;
  changeEndDay: (dayKey: DayKey) => void;
  setDurationSeconds: (seconds: number) => void;
  save: () => void;
  pending: boolean;
  error: string | null;
  dismiss: () => void;
};

export type UseEntryEditorOptions = {
  /** Applies the update. `EntryMutations["updateEntry"]` in the app. */
  onSave: (args: UpdateEntryArgs) => Promise<EntryMutationResult>;
  /** Called after a successful save — closing the dialog, in the app. */
  onDone: () => void;
};

/**
 * Buffered editing state for one entry, reseeded whenever a different entry is
 * opened. `null` is a closed editor: the times still hold something valid so
 * nothing downstream has to handle an absent instant, and saving is a no-op.
 */
export const useEntryEditor = (
  entry: DetailedEntry | null,
  { onSave, onDone }: UseEntryEditorOptions
): EntryEditor => {
  const { fields, setFields } = useEntryFields(
    () => (entry === null ? emptyEntryFields() : entryFieldsFrom(entry)),
    entry?.id ?? null
  );
  const [start, setStart] = React.useState<string>(() =>
    new Date().toISOString()
  );
  const [end, setEnd] = React.useState<string>(() => new Date().toISOString());

  // Everything in this editor is read and written in the zone the entry was
  // RECORDED in, so opening it from elsewhere shows the original wall-clock
  // time and saving it unchanged does not move the entry.
  const entryZone = entry?.timeZone ?? deviceTimeZone();
  const foreignZone =
    entry !== null &&
    !isSameZone(entryZone, deviceTimeZone(), Date.parse(entry.start));

  // Reseed the times whenever a different entry is opened. The fields do the
  // same, keyed on the id, inside `useEntryFields`.
  const entryId = entry?.id ?? null;
  const [lastEntryId, setLastEntryId] = React.useState<string | null>(null);
  if (lastEntryId !== entryId) {
    setLastEntryId(entryId);
    if (entry !== null) {
      setStart(entry.start);
      setEnd(entry.end ?? new Date().toISOString());
    }
  }

  const seconds = editorDurationSeconds({ start, end });

  const changeStartDay = React.useCallback(
    (dayKey: DayKey): void => {
      // Moving the start date carries the end with it, so the entry keeps its
      // length instead of silently stretching.
      const next = movedStartDay({ start, end }, dayKey, entryZone);
      setStart(next.start);
      setEnd(next.end);
    },
    [end, entryZone, start]
  );

  const changeEndDay = React.useCallback(
    (dayKey: DayKey): void => {
      setEnd(movedEndDay({ start, end }, dayKey, entryZone).end);
    },
    [end, entryZone, start]
  );

  const setDurationSeconds = React.useCallback(
    (next: number): void => {
      setEnd(endForDurationSeconds(start, next));
    },
    [start]
  );

  const submission = useEntrySubmission(entryId, onDone);
  const save = (): void => {
    if (entry === null) return;
    submission.submit(() => onSave(entryUpdateFrom(entry, fields, { start, end })));
  };

  return {
    fields,
    setFields,
    start,
    end,
    setStart,
    setEnd,
    entryZone,
    foreignZone,
    isRunning: entry?.end === null,
    seconds,
    startDayKey: dayKeyInZone(Date.parse(start), entryZone),
    endDayKey: dayKeyInZone(Date.parse(end), entryZone),
    changeStartDay,
    changeEndDay,
    setDurationSeconds,
    save,
    pending: submission.pending,
    error: submission.error,
    dismiss: submission.dismiss,
  };
};
