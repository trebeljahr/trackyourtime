"use client";

import * as React from "react";

import { NumberInput } from "@/components/ui/number-input";
import {
  formatNumberInput,
  parseDecimalInput,
} from "@/components/ui/number-input-math";

export type NumberFieldProps = {
  value: number;
  /** Called only when the parsed, clamped value actually differs. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  /** How far the stepper moves. Whole units by default: 100 → 101, never 100.01. */
  step?: number;
  /** Decimals a typed value keeps. 0 for a count of minutes, 2 for a rate. */
  precision?: number;
  /** Rendered inside the field, e.g. "min" or a currency code. */
  suffix?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
  "aria-label"?: string;
};

/** How long a run of steps may pause before it is saved as one change. */
export const STEP_COMMIT_DELAY_MS = 400;

/**
 * A numeric setting that saves on blur, Enter or a step — never on a
 * keystroke, so a half-typed "1" is not saved as an hourly rate of one.
 *
 * A step is a whole value the person chose, so it saves on its own, but a
 * run of five clicks is one decision, not five: each step restarts a short
 * timer, and the value at the end of the run is what is sent. Five racing
 * saves could otherwise land out of order and leave the third one stored.
 * Blur and Enter send a pending step at once.
 */
export function NumberField({
  value,
  onCommit,
  min = 0,
  max,
  step = 1,
  precision = 0,
  suffix,
  id,
  disabled,
  className,
  testId,
  "aria-label": ariaLabel,
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string>(String(value));
  const [lastValue, setLastValue] = React.useState<number>(value);
  const pendingStep = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render-time sync: the React Compiler rules reject setState inside effects.
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(String(value));
  }

  const commit = (raw: string): void => {
    if (pendingStep.current !== null) {
      clearTimeout(pendingStep.current);
      pendingStep.current = null;
    }
    const parsed = parseDecimalInput(raw);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    const upper = max ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.min(upper, Math.max(min, parsed));
    const next = Number(formatNumberInput(clamped, precision));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <NumberInput
      id={id}
      value={draft}
      onValueChange={(next, source) => {
        setDraft(next);
        if (source !== "step") return;
        if (pendingStep.current !== null) clearTimeout(pendingStep.current);
        pendingStep.current = setTimeout(() => commit(next), STEP_COMMIT_DELAY_MS);
      }}
      min={min}
      max={max}
      step={step}
      precision={precision}
      suffix={suffix}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(String(value));
        }
      }}
      data-testid={testId}
    />
  );
}
