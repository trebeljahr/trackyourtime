"use client";

import * as React from "react";
import {
  formatClockInZone,
  parseTimeOfDay,
  parseTimeOfDayInZone,
  type TimeFormat,
} from "@starter/shared";

import { Input } from "@/components/ui/input";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type TimeFieldProps = {
  /** ISO datetime. The date part is preserved; only the clock time is edited. */
  value: string;
  /**
   * IANA zone to read and write the clock in. Pass the ENTRY's recorded zone so
   * the time shown is the time it was written at, and retyping it does not move
   * the entry. Omitted falls back to the device's own zone.
   */
  timeZone?: string | null;
  onCommit: (iso: string) => void;
  timeFormat?: TimeFormat;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  testId?: string;
};

/**
 * Clock-time field anchored to the day its value already sits on.
 *
 * Accepts everything `parseTimeOfDay` does ("9:15", "0915", "9pm"). Editing is
 * local until blur or Enter so a half-typed time never fires a mutation, and
 * Escape restores the committed value.
 */
export function TimeField({
  value,
  onCommit,
  timeZone = null,
  timeFormat = "24h",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  testId = "time-field",
}: TimeFieldProps): React.JSX.Element {
  const tc = useT("common");
  const format = useFormat();
  const display = React.useMemo(
    () =>
      timeZone
        ? formatClockInZone(value, timeZone, timeFormat)
        : format.time(value, timeFormat),
    [format, value, timeZone, timeFormat]
  );

  const [draft, setDraft] = React.useState(display);
  const [editing, setEditing] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [lastDisplay, setLastDisplay] = React.useState(display);

  // Adopt sync-driven changes unless the user is mid-edit.
  if (lastDisplay !== display) {
    setLastDisplay(display);
    if (!editing) setDraft(display);
  }

  const commit = React.useCallback((): void => {
    const parsed = timeZone
      ? parseTimeOfDayInZone(draft, value, timeZone)
      : parseTimeOfDay(draft, value);
    if (parsed === null) {
      setInvalid(true);
      setDraft(display);
      return;
    }
    setInvalid(false);
    setDraft(format.time(parsed, timeFormat));
    if (parsed !== value) onCommit(parsed);
  }, [draft, display, format, onCommit, timeFormat, timeZone, value]);

  return (
    <Input
      value={draft}
      disabled={disabled}
      spellCheck={false}
      aria-label={ariaLabel ?? tc("fields.time")}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-8 w-[4.5rem] px-1 text-center font-mono text-sm tabular-nums",
        className
      )}
      onFocus={(event) => {
        setEditing(true);
        setInvalid(false);
        event.target.select();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        setEditing(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setInvalid(false);
          setDraft(display);
          event.currentTarget.blur();
        }
      }}
      data-testid={testId}
    />
  );
}
