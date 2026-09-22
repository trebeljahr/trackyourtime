"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import {
  atStepBound,
  parseDecimalInput,
  stepNumberInput,
} from "@/components/ui/number-input-math";

export type NumberInputChangeSource = "type" | "step";

export type NumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "step" | "min" | "max" | "className"
> & {
  /** The text in the field. Blank is a state, not an error. */
  value: string;
  /**
   * Every change, typed or stepped. `source` says which: a settings field
   * saves a step at once but waits for a blur on typed text.
   */
  onValueChange: (next: string, source: NumberInputChangeSource) => void;
  /** How far the stepper and the arrow keys move. Shift multiplies by ten. */
  step?: number;
  min?: number;
  max?: number;
  /** Decimals kept after a step: 0 for a count, 2 for money. */
  precision?: number;
  /** Rendered inside the field, before the stepper — a unit or a currency. */
  suffix?: React.ReactNode;
  /** The frame around field, suffix and stepper. */
  className?: string;
  /** The `<input>` itself, for a text size. */
  inputClassName?: string;
};

/**
 * The one numeric field: text input, unit and a stepper of our own.
 *
 * Not `type="number"`. Its spinner is drawn by the browser, unthemed, and
 * lands beside whatever suffix the field shows; its validation refuses a
 * comma; and it silently drops a value with more decimals than `step`
 * allows. So the input is text with a decimal keyboard, the two buttons are
 * ours, and `role="spinbutton"` tells assistive technology what the arrow
 * keys do.
 *
 * The stepper moves by whole steps and keeps the decimals a person typed:
 * 87.5 steps to 88.5, never to 88. What a step may keep is `precision`.
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      onValueChange,
      step = 1,
      min,
      max,
      precision = 2,
      suffix,
      className,
      inputClassName,
      disabled,
      onKeyDown,
      ...props
    },
    ref,
  ) {
    const tc = useT("common");
    const bounds = { step, min, max, precision };

    const bump = (direction: 1 | -1, multiplier = 1): void => {
      onValueChange(
        stepNumberInput(value, direction, { ...bounds, step: step * multiplier }),
        "step",
      );
    };

    const current = parseDecimalInput(value);

    return (
      <div
        className={cn(
          "flex h-9 w-full items-stretch overflow-hidden rounded-md border border-input bg-transparent shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          "has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50",
          "has-[input[aria-invalid=true]]:border-destructive",
          className,
        )}
      >
        <input
          ref={ref}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          role="spinbutton"
          aria-valuenow={current ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value, "type")}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              bump(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 10 : 1);
            }
          }}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 py-1 text-right text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
            inputClassName,
          )}
          {...props}
        />
        {suffix !== undefined && suffix !== null ? (
          <span className="pointer-events-none flex shrink-0 select-none items-center pr-2 text-xs text-muted-foreground">
            {suffix}
          </span>
        ) : null}
        <div className="flex shrink-0 flex-col border-l border-input">
          <StepButton
            direction={1}
            label={tc("actions.increase")}
            disabled={disabled || atStepBound(value, 1, bounds)}
            onStep={bump}
          >
            <ChevronUp className="size-3" />
          </StepButton>
          <StepButton
            direction={-1}
            label={tc("actions.decrease")}
            disabled={disabled || atStepBound(value, -1, bounds)}
            onStep={bump}
            className="border-t border-input"
          >
            <ChevronDown className="size-3" />
          </StepButton>
        </div>
      </div>
    );
  },
);

type StepButtonProps = {
  direction: 1 | -1;
  label: string;
  disabled?: boolean;
  onStep: (direction: 1 | -1, multiplier: number) => void;
  className?: string;
  children: React.ReactNode;
};

/**
 * One half of the stepper. Out of the tab order, like the native spinner:
 * the arrow keys already reach the same thing from the field. Pressing it
 * leaves focus where it is, so a settings field does not blur (and commit a
 * half-typed draft) because its button was clicked.
 */
function StepButton({
  direction,
  label,
  disabled,
  onStep,
  className,
  children,
}: StepButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onStep(direction, event.shiftKey ? 10 : 1)}
      className={cn(
        "flex flex-1 items-center justify-center px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      data-testid={direction > 0 ? "number-input-increase" : "number-input-decrease"}
    >
      {children}
    </button>
  );
}
