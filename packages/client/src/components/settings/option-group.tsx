"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type Option<T extends string> = {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  testId?: string;
};

export type OptionGroupProps<T extends string> = {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

/**
 * A segmented control. Preferred over a <Select> for two- and three-way
 * preferences: both choices stay visible, which is the point on a settings
 * screen where the current value is the question being answered.
 */
export function OptionGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: OptionGroupProps<T>): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        // Wraps inside its border rather than pushing the page sideways when
        // the labels run long (German, the pseudo-locale) on a phone.
        "inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1",
        className
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <Button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            variant={selected ? "secondary" : "ghost"}
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              "h-8 gap-1.5 px-3",
              selected ? "shadow-sm" : "text-muted-foreground"
            )}
            data-testid={option.testId}
            data-state={selected ? "on" : "off"}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
