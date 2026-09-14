"use client";

import * as React from "react";
import {
  ELECTRONIC_ADDRESS_SCHEMES,
  IDENTITY_LIMITS,
  type ElectronicAddressScheme,
} from "@starter/shared";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { checkElectronicAddress, type FieldCheck } from "./billing-fields";
import { NativeSelect } from "./native-select";
import { DEEP_LINK_HIGHLIGHT_CLASS } from "./use-deep-link-focus";

/** The draft of the pair, as a form holds it: the value as typed, the scheme as picked. */
export type ElectronicAddressDraft = {
  electronicAddress: string;
  electronicAddressScheme: ElectronicAddressScheme;
};

/** A stored pair as a draft. No scheme yet reads as email, the usual first choice. */
export function electronicAddressDraftFrom(value: {
  electronicAddress: string | null;
  electronicAddressScheme: ElectronicAddressScheme | null;
}): ElectronicAddressDraft {
  return {
    electronicAddress: value.electronicAddress ?? "",
    electronicAddressScheme: value.electronicAddressScheme ?? "EM",
  };
}

/**
 * The pair to send, checked with the shared rule. Blank sends both as null,
 * so the server's pairing rule never sees a scheme without a value.
 */
export function electronicAddressInput(
  draft: ElectronicAddressDraft,
):
  | { ok: true; electronicAddress: string | null; electronicAddressScheme: ElectronicAddressScheme | null }
  | Extract<FieldCheck, { ok: false }> {
  const check = checkElectronicAddress(draft.electronicAddressScheme, draft.electronicAddress);
  if (!check.ok) return check;
  return check.value === null
    ? { ok: true, electronicAddress: null, electronicAddressScheme: null }
    : { ok: true, electronicAddress: check.value, electronicAddressScheme: draft.electronicAddressScheme };
}

export type ElectronicAddressFieldProps = {
  /** Id and test id prefix: `${prefix}-electronicAddress`, `${prefix}-electronicAddressScheme`. */
  prefix: string;
  value: ElectronicAddressDraft;
  onChange: (next: ElectronicAddressDraft) => void;
  /** The party's email: what the snapshot uses when the value is left empty. */
  emailPlaceholder: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
};

/**
 * Scheme + value as one control, for an explicit-Save form. It holds no
 * state: the form owns the draft and asks `electronicAddressInput` whether it
 * may save.
 */
export function ElectronicAddressField({
  prefix,
  value,
  onChange,
  emailPlaceholder,
  hint,
  disabled,
}: ElectronicAddressFieldProps): React.JSX.Element {
  const t = useT("einvoice");
  const check = electronicAddressInput(value);
  const valueId = `${prefix}-electronicAddress`;
  const schemeId = `${prefix}-electronicAddressScheme`;
  const email = emailPlaceholder?.trim() ? emailPlaceholder.trim() : null;

  return (
    <div
      className={cn("space-y-1.5 text-left", DEEP_LINK_HIGHLIGHT_CLASS)}
      data-field="electronicAddress"
    >
      <Label htmlFor={valueId}>{t("address.label")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <NativeSelect
          id={schemeId}
          value={value.electronicAddressScheme}
          disabled={disabled}
          aria-label={t("address.scheme")}
          className="sm:w-36"
          onChange={(event) =>
            onChange({
              ...value,
              electronicAddressScheme: event.target.value as ElectronicAddressScheme,
            })
          }
          data-testid={schemeId}
        >
          {ELECTRONIC_ADDRESS_SCHEMES.map((option) => (
            <option key={option} value={option}>
              {t(`schemes.${option}`)}
            </option>
          ))}
        </NativeSelect>
        <Input
          id={valueId}
          value={value.electronicAddress}
          disabled={disabled}
          type={value.electronicAddressScheme === "EM" ? "email" : "text"}
          maxLength={IDENTITY_LIMITS.electronicAddress}
          placeholder={email ? t("address.placeholderFromEmail", { email }) : undefined}
          aria-invalid={!check.ok}
          onChange={(event) => onChange({ ...value, electronicAddress: event.target.value })}
          data-testid={valueId}
        />
      </div>
      {!check.ok ? (
        <p className="text-sm text-destructive" role="alert" data-testid={`${valueId}-error`}>
          {t(`errors.${check.errorKey}`)}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
