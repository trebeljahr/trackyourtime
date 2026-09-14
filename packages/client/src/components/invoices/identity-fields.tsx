"use client";

// The postal half of an invoice party, shared by the business profile form
// and a client's billing details — the two things an invoice prints side by
// side, so they are edited the same way.
//
// Form state is plain strings. What reaches the server is whatever the person
// typed; blank-to-null, trimming and the upper-cased country code are the
// server's job (`normalizeClientBilling` / `normalizeBusinessProfile`), so the
// form and the stored row cannot disagree about what "empty" means.
import * as React from "react";

import { DEEP_LINK_HIGHLIGHT_CLASS } from "@/components/einvoice/use-deep-link-focus";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** How many street lines the forms offer. The server accepts up to four. */
export const ADDRESS_LINE_COUNT = 2;

export type PostalDraft = {
  legalName: string;
  addressLines: string[];
  postalCode: string;
  city: string;
  country: string;
  taxId: string;
  email: string;
};

type PostalValue = {
  legalName: string | null;
  addressLines: readonly string[];
  postalCode: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
  email: string | null;
};

/** Editable strings for a stored party, or a blank draft for none. */
export function postalDraftFrom(value: PostalValue | null | undefined): PostalDraft {
  const lines = [...(value?.addressLines ?? [])];
  while (lines.length < ADDRESS_LINE_COUNT) lines.push("");
  return {
    legalName: value?.legalName ?? "",
    addressLines: lines,
    postalCode: value?.postalCode ?? "",
    city: value?.city ?? "",
    country: value?.country ?? "",
    taxId: value?.taxId ?? "",
    email: value?.email ?? "",
  };
}

/** A country code field holds nothing or exactly two letters. */
export function isCountryDraftValid(country: string): boolean {
  return /^([A-Za-z]{2})?$/.test(country.trim());
}

export type PostalFieldLabels = {
  legalName: string;
  addressLine: (line: number) => string;
  postalCode: string;
  city: string;
  country: string;
  taxId: string;
  email: string;
  invalidCountry: string;
};

export type PostalFieldsProps = {
  draft: PostalDraft;
  onChange: (next: PostalDraft) => void;
  labels: PostalFieldLabels;
  /** Prefix for element ids and `data-testid`s, e.g. "business-profile". */
  prefix: string;
  disabled?: boolean;
  /**
   * Render the free-text tax ID input. The e-invoice forms render it
   * themselves, beside the VAT ID it is meant to become.
   */
  showTaxId?: boolean;
};

export type IdentityInputProps = Omit<React.ComponentProps<typeof Input>, "id" | "onChange"> & {
  prefix: string;
  /** Main's model key: the input's id and test id suffix, and its `data-field`. */
  fieldKey: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
  /** Shown instead of the hint, and marks the input invalid. */
  error?: string | null;
  className?: string;
};

/**
 * One labelled input of an identity form, wrapped in `data-field` so an
 * e-invoice deep link (`?field=<key>`) can focus and highlight it.
 */
export function IdentityInput({
  prefix,
  fieldKey,
  label,
  value,
  onChange,
  hint,
  error = null,
  className,
  ...inputProps
}: IdentityInputProps): React.JSX.Element {
  const id = `${prefix}-${fieldKey}`;
  return (
    <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS, className)} data-field={fieldKey}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        aria-invalid={error !== null}
        onChange={(event) => onChange(event.target.value)}
        data-testid={id}
        {...inputProps}
      />
      {error !== null ? (
        <p className="text-sm text-destructive" data-testid={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function PostalFields({
  draft,
  onChange,
  labels,
  prefix,
  disabled = false,
  showTaxId = true,
}: PostalFieldsProps): React.JSX.Element {
  const set = <K extends keyof PostalDraft>(key: K, value: PostalDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const countryInvalid = !isCountryDraftValid(draft.country);

  const field = (
    key: Exclude<keyof PostalDraft, "addressLines">,
    label: string,
    props: React.ComponentProps<typeof Input> = {},
  ): React.JSX.Element => (
    <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field={key}>
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      <Input
        id={`${prefix}-${key}`}
        value={draft[key]}
        disabled={disabled}
        onChange={(event) => set(key, event.target.value)}
        data-testid={`${prefix}-${key}`}
        {...props}
      />
    </div>
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        {field("legalName", labels.legalName, { maxLength: 200 })}
      </div>
      {draft.addressLines.map((line, index) => (
        <div
          className={cn("space-y-1.5 sm:col-span-2", DEEP_LINK_HIGHLIGHT_CLASS)}
          key={index}
          // A deep link to the street lands on the first line.
          data-field={index === 0 ? "addressLines" : undefined}
        >
          <Label htmlFor={`${prefix}-address-${index}`}>
            {labels.addressLine(index + 1)}
          </Label>
          <Input
            id={`${prefix}-address-${index}`}
            value={line}
            maxLength={200}
            disabled={disabled}
            onChange={(event) => {
              const addressLines = [...draft.addressLines];
              addressLines[index] = event.target.value;
              set("addressLines", addressLines);
            }}
            data-testid={`${prefix}-address-${index}`}
          />
        </div>
      ))}
      {field("postalCode", labels.postalCode, { maxLength: 20 })}
      {field("city", labels.city, { maxLength: 120 })}
      <div className="space-y-1.5">
        {field("country", labels.country, {
          maxLength: 2,
          autoCapitalize: "characters",
          "aria-invalid": countryInvalid,
        })}
        {countryInvalid ? (
          <p className="text-sm text-destructive" data-testid={`${prefix}-country-error`}>
            {labels.invalidCountry}
          </p>
        ) : null}
      </div>
      {showTaxId ? field("taxId", labels.taxId, { maxLength: 60 }) : null}
      <div className="sm:col-span-2">
        {field("email", labels.email, { type: "email", maxLength: 254 })}
      </div>
    </div>
  );
}
