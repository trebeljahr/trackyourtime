"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CATALOG_COLOR_PALETTE, isHexColor } from "@starter/shared";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/**
 * The catalog palette, from `@starter/shared` — the same list the server picks
 * from when a create ships no color, and the same one the Raycast forms offer.
 * Re-exported so the components that render swatches keep importing it here.
 */
export { CATALOG_COLOR_PALETTE as COLOR_PALETTE, isHexColor } from "@starter/shared";

const normalize = (value: string): string => {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return withHash.toLowerCase();
};

export type ColorPickerProps = {
  /** Current colour as `#rrggbb`. */
  value: string;
  onChange: (color: string) => void;
  /** Label rendered next to the swatch on the trigger. */
  label?: string;
  disabled?: boolean;
  className?: string;
  /** Prefix for the trigger/swatch test ids. */
  testId?: string;
};

/**
 * Colour picker over the catalog palette, plus a full-spectrum native input and
 * a hex field. The palette is only a set of shortcuts — any `#rrggbb` is valid,
 * so a brand colour can be pasted or dialled in directly.
 */
export function ColorPicker({
  value,
  onChange,
  label,
  disabled = false,
  className,
  testId = "color-picker",
}: ColorPickerProps): React.JSX.Element {
  const t = useT("catalog");
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [lastValue, setLastValue] = React.useState(value);

  // Adopt an externally changed colour during render — the documented
  // alternative to a setState-in-effect round trip.
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(value);
  }

  const commitDraft = React.useCallback((): void => {
    const next = normalize(draft);
    if (isHexColor(next)) {
      onChange(next);
      setOpen(false);
      return;
    }
    setDraft(value);
  }, [draft, onChange, value]);

  const pick = React.useCallback(
    (color: string): void => {
      onChange(color);
      setDraft(color);
      setOpen(false);
    },
    [onChange]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("justify-start gap-2 font-normal", className)}
          aria-label={label ?? t("colorPicker.pick")}
          data-testid={testId}
        >
          <span
            aria-hidden="true"
            className="size-4 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: isHexColor(value) ? value : undefined }}
          />
          <span className="truncate">{label ?? value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-3"
        data-testid={`${testId}-content`}
      >
        <div className="grid grid-cols-6 gap-2">
          {CATALOG_COLOR_PALETTE.map((color) => {
            const selected = normalize(value) === color;
            return (
              <button
                key={color}
                type="button"
                onClick={() => pick(color)}
                aria-label={color}
                aria-pressed={selected}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full border transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-foreground" : "border-transparent"
                )}
                style={{ backgroundColor: color }}
                data-testid={`${testId}-swatch-${color.replace("#", "")}`}
              >
                {selected ? (
                  <Check className="size-3.5 text-white drop-shadow" />
                ) : null}
              </button>
            );
          })}
        </div>

        {/* The palette is a shortcut, not the whole range: any colour is
            allowed. The native picker gives a full spectrum with an eyedropper
            on the browsers that support one, and the hex field takes a value
            pasted from a brand guide. */}
        <div className="mt-3 flex items-center gap-2">
          <input
            type="color"
            value={isHexColor(normalize(value)) ? normalize(value) : "#4f46e5"}
            onChange={(event) => {
              const next = normalize(event.target.value);
              setDraft(next);
              onChange(next);
            }}
            aria-label={t("colorPicker.custom")}
            className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            data-testid={`${testId}-custom`}
          />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === "Escape") setDraft(value);
            }}
            spellCheck={false}
            aria-label={t("colorPicker.hex")}
            placeholder="#4f46e5"
            className="h-8 font-mono text-xs"
            data-testid={`${testId}-hex`}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
