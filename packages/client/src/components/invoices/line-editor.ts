import {
  MANUAL_LINE_LIMITS,
  lineKind,
  manualLineAmount,
  manualLineQuantitySchema,
  manualLineUnitPriceSchema,
  newManualLineKey,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceLineUnit,
  type Locale,
  type ManualInvoiceLineInput,
  type UpdateInvoiceInput,
} from "@starter/shared";

import type { InvoiceTaxInputs } from "./invoice-tax-section";
import { toDateInputValue } from "./types";

/*
 * The line editor's state and arithmetic, without a DOM.
 *
 * A draft is edited as a list of lines the person can see: the time lines
 * the invoice already bills (relabel only) and the manual lines they type.
 * Quantities and prices are held as the TEXT typed, so a half-typed "1," is
 * not rounded away under the cursor; the amount beside a line is computed
 * from the parsed values with the same `manualLineAmount` the server stores,
 * so what the screen shows is what will be saved. Nothing here sends: the
 * builders at the bottom turn the state into the exact `invoices.update` or
 * `invoices.create` input, and the component only forwards it.
 */

/** A time line of the draft: everything but the label is the entries' and stays. */
export type TimeLineDraft = {
  kind: "time";
  key: string;
  label: string;
  /** The stored line, for the figures the row shows and for change detection. */
  original: InvoiceLineItem;
};

/** A manual line as typed. `quantity` and `unitPrice` are raw input. */
export type ManualLineDraft = {
  kind: "manual";
  /** `manual:<id>`, chosen here so a VAT choice can address the line before it is saved. */
  key: string;
  label: string;
  quantity: string;
  unit: InvoiceLineUnit;
  unitPrice: string;
};

export type EditableLine = TimeLineDraft | ManualLineDraft;

/** A fresh manual line: one hour, no price yet. */
export function newManualLineDraft(random: () => number = Math.random): ManualLineDraft {
  return { kind: "manual", key: newManualLineKey(random), label: "", quantity: "1", unit: "hour", unitPrice: "" };
}

/** Numbers as an editor shows them: a plain decimal with a dot, trailing zeros trimmed. */
export function decimalInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(3)));
}

/** The stored lines as editable lines, in stored order. */
export function linesFromInvoice(invoice: Pick<Invoice, "lineItems">): EditableLine[] {
  return invoice.lineItems.map((line): EditableLine =>
    lineKind(line) === "manual"
      ? {
          kind: "manual",
          key: line.key,
          label: line.label,
          quantity: decimalInput(line.quantity ?? line.hours),
          unit: line.unit ?? "hour",
          unitPrice: decimalInput(line.unitPrice ?? line.hourlyRate),
        }
      : { kind: "time", key: line.key, label: line.label, original: line },
  );
}

/**
 * A typed number: a decimal comma is accepted beside the dot ("7,5"), since
 * that is how half the readers of a German UI type a fraction. Blank or
 * unparseable is `null`.
 */
export function parseDecimalInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const normalised = /^[+-]?\d*,\d+$/.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

export type ManualLineField = "label" | "quantity" | "unitPrice";

export type ManualLineCheck =
  | { ok: true; input: ManualInvoiceLineInput }
  | { ok: false; errors: ManualLineField[] };

/**
 * A manual line as the server would take it, or the fields that stop it.
 * The number rules are the shared zod pieces the server validates with, so
 * the editor and the server cannot disagree about what a quantity is.
 */
export function checkManualLine(line: ManualLineDraft): ManualLineCheck {
  const errors: ManualLineField[] = [];
  const label = line.label.trim();
  if (label === "" || label.length > MANUAL_LINE_LIMITS.label) errors.push("label");
  const quantity = parseDecimalInput(line.quantity);
  if (quantity === null || !manualLineQuantitySchema.safeParse(quantity).success) {
    errors.push("quantity");
  }
  const unitPrice = parseDecimalInput(line.unitPrice);
  if (unitPrice === null || !manualLineUnitPriceSchema.safeParse(unitPrice).success) {
    errors.push("unitPrice");
  }
  if (errors.length > 0 || quantity === null || unitPrice === null) return { ok: false, errors };
  return { ok: true, input: { key: line.key, label, quantity, unit: line.unit, unitPrice } };
}

/** The amount a line will carry: a time line's stored one, a manual line's from its typed figures, or null while unparseable. */
export function lineAmount(line: EditableLine): number | null {
  if (line.kind === "time") return line.original.amount;
  const quantity = parseDecimalInput(line.quantity);
  const unitPrice = parseDecimalInput(line.unitPrice);
  if (quantity === null || unitPrice === null) return null;
  return manualLineAmount(quantity, unitPrice);
}

/** The sum of every line that has an amount, in whole cents. */
export function editorSubtotal(lines: readonly EditableLine[]): number {
  const cents = lines.reduce((sum, line) => sum + Math.round((lineAmount(line) ?? 0) * 100), 0);
  return cents / 100;
}

/** Every manual line's validity, keyed by its key: the rows to highlight. */
export function invalidManualLines(lines: readonly EditableLine[]): Map<string, ManualLineField[]> {
  const invalid = new Map<string, ManualLineField[]>();
  for (const line of lines) {
    if (line.kind !== "manual") continue;
    const check = checkManualLine(line);
    if (!check.ok) invalid.set(line.key, check.errors);
  }
  return invalid;
}

/**
 * The `lines` of a create request: the manual lines that parse, in order.
 * Lines that do not parse yet are left out — a preview shows what is ready —
 * and `invalidManualLines` says which they are.
 */
export function manualLinesInput(lines: readonly EditableLine[]): ManualInvoiceLineInput[] {
  const inputs: ManualInvoiceLineInput[] = [];
  for (const line of lines) {
    if (line.kind !== "manual") continue;
    const check = checkManualLine(line);
    if (check.ok) inputs.push(check.input);
  }
  return inputs;
}

/** True when the edited list differs from the stored one: order, labels, or any manual figure. */
export function linesChanged(invoice: Pick<Invoice, "lineItems">, lines: readonly EditableLine[]): boolean {
  const before = linesFromInvoice(invoice);
  if (before.length !== lines.length) return true;
  return before.some((stored, index) => {
    const edited = lines[index];
    if (!edited || edited.kind !== stored.kind || edited.key !== stored.key) return true;
    if (edited.label.trim() !== stored.label.trim()) return true;
    if (edited.kind === "manual" && stored.kind === "manual") {
      return (
        parseDecimalInput(edited.quantity) !== parseDecimalInput(stored.quantity) ||
        edited.unit !== stored.unit ||
        parseDecimalInput(edited.unitPrice) !== parseDecimalInput(stored.unitPrice)
      );
    }
    return false;
  });
}

/** What the edit form holds beside the lines. Dates are "YYYY-MM-DD" input values. */
export type DraftEdits = {
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  /** `null` keeps the document's language (or its absence). */
  locale: Locale | null;
  lines: EditableLine[];
  /**
   * The VAT to send, or `null` to leave the stored VAT alone. The form passes
   * `taxInputsFromState` when the VAT section was touched, or when the lines
   * changed and the section holds a real choice — so a new line follows it.
   */
  tax: InvoiceTaxInputs | null;
};

export type UpdateInputResult =
  | { ok: true; input: Omit<UpdateInvoiceInput, "originId">; changed: boolean }
  | { ok: false; reason: "invalid-lines" | "number" | "dates" };

/**
 * The `invoices.update` input for the edits: only what differs from the
 * stored invoice, so an untouched field is not re-sent. `changed` is false
 * when nothing differs, and the form has nothing to save.
 */
export function buildUpdateInput(invoice: Invoice, edits: DraftEdits): UpdateInputResult {
  const number = edits.number.trim();
  if (number === "" || number.length > 40) return { ok: false, reason: "number" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edits.issueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(edits.dueDate)) {
    return { ok: false, reason: "dates" };
  }
  if (edits.dueDate < edits.issueDate) return { ok: false, reason: "dates" };
  if (invalidManualLines(edits.lines).size > 0) return { ok: false, reason: "invalid-lines" };

  const input: Omit<UpdateInvoiceInput, "originId"> = { id: invoice.id, updatedAt: invoice.updatedAt };
  if (number !== invoice.number) input.number = number;
  if (edits.issueDate !== toDateInputValue(invoice.issueDate)) input.issueDate = edits.issueDate;
  if (edits.dueDate !== toDateInputValue(invoice.dueDate)) input.dueDate = edits.dueDate;
  const notes = edits.notes.trim();
  if (notes !== (invoice.notes ?? "")) input.notes = notes === "" ? null : notes;
  if (edits.locale !== null && edits.locale !== invoice.locale) input.locale = edits.locale;

  if (linesChanged(invoice, edits.lines)) {
    input.lines = edits.lines.map((line) => {
      if (line.kind === "time") {
        const label = line.label.trim();
        return label === line.original.label
          ? { kind: "time" as const, key: line.key }
          : { kind: "time" as const, key: line.key, label };
      }
      const check = checkManualLine(line);
      if (!check.ok) throw new Error("unreachable: invalid lines were refused above");
      return { kind: "manual" as const, ...check.input };
    });
  }

  if (edits.tax !== null) {
    input.taxRate = edits.tax.taxRate;
    if (edits.tax.tax) input.tax = edits.tax.tax;
    if (edits.tax.lineTax) input.lineTax = edits.tax.lineTax;
    if (edits.tax.exemptionNotes) input.exemptionNotes = edits.tax.exemptionNotes;
  }

  const changed = Object.keys(input).length > 2;
  return { ok: true, input, changed };
}
