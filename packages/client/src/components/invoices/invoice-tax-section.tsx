"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import type { ExemptionNotes, InvoiceLineItem, LineTax, TaxCategory } from "@starter/shared";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  lineTaxToTaxChoice,
  sameTaxChoice,
  taxChoiceToLineTax,
  type TaxChoice,
} from "@/components/einvoice/billing-fields";
import { TaxChoiceSelect } from "@/components/einvoice/tax-choice-select";
import { useT } from "@/i18n/use-t";

type NoteCategory = "E" | "AE" | "O";
const NOTE_CATEGORIES: readonly NoteCategory[] = ["E", "AE", "O"];

export type InvoiceTaxState = {
  /** False until the user changes anything: only then is a server default no longer adopted. */
  touched: boolean;
  all: TaxChoice;
  perLine: boolean;
  /** By line key; absent = follows `all`. */
  lines: Record<string, TaxChoice>;
  notes: Partial<Record<NoteCategory, string>>;
};

export const INITIAL_INVOICE_TAX_STATE: InvoiceTaxState = {
  touched: false,
  all: { kind: "unset" },
  perLine: false,
  lines: {},
  notes: {},
};

export type InvoiceTaxInputs = {
  tax?: LineTax;
  lineTax?: Array<LineTax & { key: string }>;
  exemptionNotes?: ExemptionNotes;
  taxRate: number | null;
};

export type InvoiceTaxInputsResult =
  | { ok: true; inputs: InvoiceTaxInputs }
  | { ok: false; errorKey: "rate" | "oMixed" | "lineRate"; lineKey?: string };

const taxKey = (tax: LineTax): string => `${tax.category}:${tax.rate}`;

/** Adopt what the server resolved (client default → profile default) as the section's state. */
export function stateFromResolvedTax(
  resolved: { lines: Array<{ key: string } & LineTax> } | null,
  notes: ExemptionNotes,
): InvoiceTaxState {
  const adoptedNotes: Partial<Record<NoteCategory, string>> = {};
  for (const category of NOTE_CATEGORIES) {
    const note = notes[category];
    if (typeof note === "string" && note !== "") adoptedNotes[category] = note;
  }
  if (resolved === null || resolved.lines.length === 0) {
    return { ...INITIAL_INVOICE_TAX_STATE, notes: adoptedNotes };
  }
  // The most common tax becomes the invoice-wide choice; the rest are per-line.
  const counts = new Map<string, { tax: LineTax; count: number }>();
  for (const line of resolved.lines) {
    const key = taxKey(line);
    const entry = counts.get(key) ?? { tax: { category: line.category, rate: line.rate }, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const common = [...counts.values()].sort((a, b) => b.count - a.count)[0].tax;
  const lines: Record<string, TaxChoice> = {};
  for (const line of resolved.lines) {
    if (taxKey(line) !== taxKey(common)) lines[line.key] = lineTaxToTaxChoice(line);
  }
  return {
    touched: false,
    all: lineTaxToTaxChoice(common),
    perLine: Object.keys(lines).length > 0,
    lines,
    notes: adoptedNotes,
  };
}

/**
 * Per-line overrides for the lines a new preview answered with. An override
 * whose line key is still there is kept — a wider range or another week adds
 * and drops lines, it does not change what the remaining ones are. Keys that
 * are gone are dropped, so a stale choice cannot come back with a later range.
 * Returns the same object when nothing changed.
 */
export function pruneLineOverrides(state: InvoiceTaxState, lineKeys: readonly string[]): InvoiceTaxState {
  const keep = new Set(lineKeys);
  const entries = Object.entries(state.lines);
  const kept = entries.filter(([key]) => keep.has(key));
  if (kept.length === entries.length) return state;
  return { ...state, lines: Object.fromEntries(kept) };
}

/** Each line's choice after per-line overrides. */
export function effectiveLineChoices(
  state: InvoiceTaxState,
  lineKeys: readonly string[],
): Array<{ key: string; choice: TaxChoice }> {
  return lineKeys.map((key) => ({
    key,
    choice: state.perLine ? (state.lines[key] ?? state.all) : state.all,
  }));
}

/** The E / AE / O categories some line uses: each needs its reason printed. */
export function noteCategoriesInUse(state: InvoiceTaxState, lineKeys: readonly string[]): NoteCategory[] {
  // Before the first preview there are no lines yet; the invoice-wide choice speaks for them.
  const choices = lineKeys.length > 0 ? effectiveLineChoices(state, lineKeys).map((line) => line.choice) : [state.all];
  const kinds = new Set(choices.map((choice) => choice.kind));
  return NOTE_CATEGORIES.filter((category) => kinds.has(category));
}

/**
 * The input fragment preview and create both send — one function, so the two
 * requests cannot drift — or the first reason not to send one.
 */
export function taxInputsFromState(
  state: InvoiceTaxState,
  lineKeys: readonly string[],
): InvoiceTaxInputsResult {
  const all = taxChoiceToLineTax(state.all);
  if (!all.ok) return { ok: false, errorKey: "rate" };
  if (all.tax === null) {
    // "No VAT details": no category anywhere, and the legacy taxRate stays empty.
    return { ok: true, inputs: { taxRate: null } };
  }

  const categories = new Set<TaxCategory>();
  const overrides: Array<LineTax & { key: string }> = [];
  for (const { key, choice } of effectiveLineChoices(state, lineKeys)) {
    const line = taxChoiceToLineTax(choice);
    if (!line.ok) return { ok: false, errorKey: "lineRate", lineKey: key };
    const tax = line.tax ?? all.tax;
    categories.add(tax.category);
    if (state.perLine && !sameTaxChoice(choice, state.all) && line.tax !== null) {
      overrides.push({ key, ...line.tax });
    }
  }
  if (lineKeys.length === 0) categories.add(all.tax.category);
  if (categories.has("O") && categories.size > 1) {
    return { ok: false, errorKey: "oMixed" };
  }

  const exemptionNotes: ExemptionNotes = {};
  for (const category of NOTE_CATEGORIES) {
    const note = state.notes[category]?.trim();
    if (note && categories.has(category)) exemptionNotes[category] = note;
  }

  return {
    ok: true,
    inputs: {
      tax: all.tax,
      ...(overrides.length > 0 ? { lineTax: overrides } : {}),
      ...(Object.keys(exemptionNotes).length > 0 ? { exemptionNotes } : {}),
      taxRate: all.tax.rate,
    },
  };
}

/** True when a category in use has no reason typed: create is blocked, preview is not. */
export function missingExemptionNotes(state: InvoiceTaxState, lineKeys: readonly string[]): NoteCategory[] {
  return noteCategoriesInUse(state, lineKeys).filter((category) => !state.notes[category]?.trim());
}

export type InvoiceTaxSectionProps = {
  lines: ReadonlyArray<Pick<InvoiceLineItem, "key" | "label">>;
  value: InvoiceTaxState;
  onChange: (next: InvoiceTaxState) => void;
  /** From the selected client's `billing`; null while loading or unknown. */
  hasBuyerVatId: boolean | null;
  clientId: string | null;
  /**
   * Opens the client's billing details over this dialog. In place rather than
   * a link: leaving the page would throw away the unsaved invoice.
   */
  onEditClientBilling: () => void;
  /**
   * Whether "No VAT details" is offered. The server fills categories from the
   * client and profile defaults whenever none is sent, so once those resolve
   * the option could not be honoured.
   */
  unsetAllowed?: boolean;
};

/** The VAT part of the create dialog. The per-line controls render inside the preview table. */
export function InvoiceTaxSection({
  lines,
  value,
  onChange,
  hasBuyerVatId,
  clientId,
  onEditClientBilling,
  unsetAllowed = true,
}: InvoiceTaxSectionProps): React.JSX.Element {
  const t = useT("einvoice");
  const lineKeys = lines.map((line) => line.key);
  const result = taxInputsFromState(value, lineKeys);
  const inUse = noteCategoriesInUse(value, lineKeys);
  const usesAe = inUse.includes("AE");

  const change = (patch: Partial<InvoiceTaxState>): void => onChange({ ...value, ...patch, touched: true });

  return (
    <section className="space-y-4" data-testid="invoice-tax-section">
      <div className="space-y-2">
        <Label htmlFor="invoice-tax-choice">{t("tax.label")}</Label>
        <TaxChoiceSelect
          id="invoice-tax-choice"
          value={value.all}
          onChange={(all) => change(all.kind === "unset" ? { all, perLine: false, lines: {} } : { all })}
          allowUnset={unsetAllowed}
          testId="invoice-tax-choice"
        />
        {value.all.kind === "unset" ? (
          <p className="text-xs text-muted-foreground" data-testid="invoice-tax-unset-note">
            {t("tax.unsetNote")}
          </p>
        ) : null}
        {usesAe && hasBuyerVatId === false ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400" data-testid="invoice-tax-ae-vat-warning">
            <AlertTriangle className="size-4 shrink-0" />
            {t("tax.aeNeedsVatId")}
            {clientId ? (
              <button
                type="button"
                onClick={onEditClientBilling}
                className="underline underline-offset-2"
                data-testid="invoice-tax-ae-fix"
              >
                {t("tax.aeFix")}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="invoice-tax-per-line"
          checked={value.perLine}
          disabled={value.all.kind === "unset"}
          onCheckedChange={(perLine) => change({ perLine, lines: perLine ? value.lines : {} })}
          data-testid="invoice-tax-per-line"
        />
        <Label htmlFor="invoice-tax-per-line">{t("tax.perLine")}</Label>
      </div>

      {!result.ok && result.errorKey === "oMixed" ? (
        <p className="text-sm text-destructive" role="alert" data-testid="invoice-tax-o-mixed">
          {t("tax.oMixed")}
        </p>
      ) : null}

      {inUse.map((category) => {
        const note = value.notes[category] ?? "";
        return (
          <div className="space-y-1" key={category}>
            <Label htmlFor={`invoice-exemption-note-${category}`}>
              {t("tax.noteLabel", { category: t(`tax.choice.${category}`) })}
            </Label>
            <Textarea
              id={`invoice-exemption-note-${category}`}
              rows={2}
              value={note}
              aria-invalid={note.trim() === ""}
              onChange={(event) => change({ notes: { ...value.notes, [category]: event.target.value } })}
              data-testid={`invoice-exemption-note-${category}`}
            />
            {note.trim() === "" ? (
              <p className="text-xs text-destructive" data-testid={`invoice-exemption-note-${category}-error`}>
                {t("tax.noteRequired")}
              </p>
            ) : null}
          </div>
        );
      })}

    </section>
  );
}

/** The per-line VAT control for the preview table, keyed by line index in its test id. */
export function lineTaxRenderer(
  value: InvoiceTaxState,
  onChange: (next: InvoiceTaxState) => void,
  label: (line: string) => string,
): ((line: Pick<InvoiceLineItem, "key" | "label">, index: number) => React.ReactNode) | null {
  if (!value.perLine) return null;
  return (line, index) => (
    <TaxChoiceSelect
      compact
      value={value.lines[line.key] ?? value.all}
      aria-label={label(line.label)}
      onChange={(choice) =>
        onChange({ ...value, touched: true, lines: { ...value.lines, [line.key]: choice } })
      }
      testId={`invoice-line-tax-${index}`}
    />
  );
}
