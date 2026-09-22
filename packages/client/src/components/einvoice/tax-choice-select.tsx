"use client";

import * as React from "react";
import type { TaxCategory } from "@starter/shared";

import { NumberInput } from "@/components/ui/number-input";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import {
  taxChoiceHintKey,
  taxChoiceToLineTax,
  type TaxChoice,
  type TaxChoiceKind,
} from "./billing-fields";
import { NativeSelect } from "./native-select";

/** "full": every choice; "zeroRate": the four 0 % categories a legacy fill asks for. */
export type TaxChoiceMode = "full" | "zeroRate";

const FULL_KINDS: readonly TaxChoiceKind[] = ["S19", "S7", "Scustom", "Z", "E", "AE", "O", "unset"];
const ZERO_RATE_KINDS: readonly TaxChoiceKind[] = ["E", "AE", "O", "Z"];

/** The option values a mode offers, in display order. */
export function taxChoiceKinds(mode: TaxChoiceMode): readonly TaxChoiceKind[] {
  return mode === "full" ? FULL_KINDS : ZERO_RATE_KINDS;
}

const choiceFromKind = (kind: TaxChoiceKind, previous: TaxChoice | null): TaxChoice => {
  if (kind === "Scustom") {
    return { kind: "Scustom", rate: previous?.kind === "Scustom" ? previous.rate : "" };
  }
  return { kind };
};

export type TaxChoiceSelectProps = {
  /** `null` shows no selection (zero-rate mode starts that way on purpose). */
  value: TaxChoice | null;
  onChange: (next: TaxChoice) => void;
  mode?: TaxChoiceMode;
  testId: string;
  id?: string;
  disabled?: boolean;
  /** A dense cell in a table: no hint, a narrower control. */
  compact?: boolean;
  /** Per-option tag, e.g. "Your profile" beside E. */
  optionTag?: Partial<Record<TaxChoiceKind, string>>;
  "aria-label"?: string;
  className?: string;
  /** Blur or Enter in the custom-rate input: the moment an auto-saving form commits a typed rate. */
  onRateBlur?: () => void;
  /** Offer "No VAT details" in full mode. Off where the choice could not be honoured. */
  allowUnset?: boolean;
};

/** One control producing a `TaxChoice`, with the custom-rate input and the hint under it. */
export function TaxChoiceSelect({
  value,
  onChange,
  mode = "full",
  testId,
  id,
  disabled,
  compact = false,
  optionTag,
  "aria-label": ariaLabel,
  className,
  onRateBlur,
  allowUnset = true,
}: TaxChoiceSelectProps): React.JSX.Element {
  const t = useT("einvoice");
  const kinds = taxChoiceKinds(mode).filter(
    // A current "unset" stays listed, so the control never shows a value it has no option for.
    (kind) => kind !== "unset" || allowUnset || value?.kind === "unset",
  );
  const hintKey = value ? taxChoiceHintKey(value) : null;
  const rateCheck = value?.kind === "Scustom" ? taxChoiceToLineTax(value) : null;
  const rateError = rateCheck !== null && !rateCheck.ok && value?.kind === "Scustom" && value.rate.trim() !== "";

  return (
    <div className={cn("space-y-1.5 text-left", className)}>
      <div className={cn("flex gap-2", compact ? "items-center" : "flex-col sm:flex-row")}>
        <NativeSelect
          id={id}
          value={value?.kind ?? ""}
          disabled={disabled}
          aria-label={ariaLabel}
          className={compact ? "h-8 min-w-36 text-xs" : "sm:w-64"}
          onChange={(event) => {
            const kind = event.target.value as TaxChoiceKind;
            if (kinds.includes(kind)) onChange(choiceFromKind(kind, value));
          }}
          data-testid={testId}
        >
          {value === null ? (
            <option value="" disabled>
              —
            </option>
          ) : null}
          {kinds.map((kind) => (
            <option key={kind} value={kind} data-testid={`${testId}-option-${kind}`}>
              {t(`tax.choice.${kind}`)}
              {optionTag?.[kind] ? ` · ${optionTag[kind]}` : ""}
            </option>
          ))}
        </NativeSelect>
        {value?.kind === "Scustom" ? (
          <NumberInput
            value={value.rate}
            min={0}
            max={100}
            suffix="%"
            disabled={disabled}
            placeholder={t("tax.customRate")}
            aria-label={t("tax.customRate")}
            aria-invalid={rateError}
            className={compact ? "h-8 w-28" : "sm:w-32"}
            inputClassName={compact ? "text-xs" : undefined}
            onValueChange={(next) => onChange({ kind: "Scustom", rate: next })}
            onBlur={onRateBlur}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onRateBlur?.();
              }
            }}
            data-testid={`${testId}-custom-rate`}
          />
        ) : null}
      </div>
      {rateError ? (
        <p className="text-xs text-destructive" data-testid={`${testId}-rate-error`}>
          {t("errors.rate")}
        </p>
      ) : null}
      {!compact && hintKey ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-hint`}>
          {t(`tax.hint.${hintKey}`)}
        </p>
      ) : null}
    </div>
  );
}

const CATEGORY_OPTIONS: ReadonlyArray<TaxCategory | "unset"> = ["unset", "S", "Z", "E", "AE", "O"];

export type TaxCategorySelectProps = {
  value: TaxCategory | null;
  onChange: (next: TaxCategory | null) => void;
  testId: string;
  id?: string;
  disabled?: boolean;
};

/** Category only, for a client's default (S takes the rate from the billing profile). */
export function TaxCategorySelect({
  value,
  onChange,
  testId,
  id,
  disabled,
}: TaxCategorySelectProps): React.JSX.Element {
  const t = useT("einvoice");
  return (
    <NativeSelect
      id={id}
      value={value ?? "unset"}
      disabled={disabled}
      className="sm:w-64"
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === "unset" ? null : (next as TaxCategory));
      }}
      data-testid={testId}
    >
      {CATEGORY_OPTIONS.map((option) => (
        <option key={option} value={option} data-testid={`${testId}-option-${option}`}>
          {t(`tax.choice.${option}`)}
        </option>
      ))}
    </NativeSelect>
  );
}
