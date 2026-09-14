"use client";

import * as React from "react";
import { parseDurationInput, type DurationFormat } from "@starter/shared";

import { Input } from "@/components/ui/input";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type DurationInputProps = {
  /** Current duration in whole seconds. */
  value: number;
  /** Called with the parsed seconds on blur or Enter, only when it changed. */
  onCommit: (seconds: number) => void;
  format?: DurationFormat;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  testId?: string;
};

/**
 * Duration field that accepts everything a time tracker should — "1:30",
 * "1h30m", "90", "1.5h" — and renders back in the user's duration format.
 *
 * Editing is local until the user commits (blur or Enter) so a half-typed
 * value never fires a mutation; Escape restores the last committed value.
 */
export function DurationInput({
  value,
  onCommit,
  format = "hms",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  testId = "duration-input",
}: DurationInputProps): React.JSX.Element {
  const tc = useT("common");
  const localeFormat = useFormat();
  // Every form this prints parses back through `parseDurationInput`, which
  // takes a decimal comma as readily as a dot.
  const display = React.useMemo(
    () => localeFormat.duration(value, format),
    [localeFormat, value, format]
  );

  const [draft, setDraft] = React.useState(display);
  const [editing, setEditing] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [lastDisplay, setLastDisplay] = React.useState(display);

  // Adopt external changes (sync events, other tabs) unless mid-edit —
  // clobbering a half-typed value would be worse than showing it stale.
  if (lastDisplay !== display) {
    setLastDisplay(display);
    if (!editing) setDraft(display);
  }

  const commit = React.useCallback((): void => {
    const parsed = parseDurationInput(draft);
    if (parsed === null) {
      setInvalid(true);
      setDraft(display);
      return;
    }
    setInvalid(false);
    setDraft(localeFormat.duration(parsed, format));
    if (parsed !== value) onCommit(parsed);
  }, [draft, display, format, localeFormat, onCommit, value]);

  return (
    <Input
      value={draft}
      disabled={disabled}
      spellCheck={false}
      inputMode="text"
      aria-label={ariaLabel ?? tc("fields.duration")}
      aria-invalid={invalid || undefined}
      className={cn("w-24 text-center font-mono tabular-nums", className)}
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
          setInvalid(false);
          setDraft(display);
          event.currentTarget.blur();
        }
      }}
      data-testid={testId}
    />
  );
}
