// VAT categories for a new invoice, decided once at preview/create.
//
// A category is chosen, never inferred from a rate: 0 % is exempt, reverse
// charge, not subject to VAT or zero rated, and each needs different wording.
// So when nothing names a category for every line, NO line gets one and the
// invoice is plain-PDF only — it follows the legacy path, where the user picks.
import {
  DEFAULT_EXEMPTION_NOTES,
  EXEMPTION_NOTE_CATEGORIES,
  sumAmounts,
  type BusinessProfileValues,
  type ClientBilling,
  type ExemptionNoteCategory,
  type ExemptionNotes,
  type InvoiceLineItem,
  type LineTax,
  type Locale,
  type TaxBreakdownRow,
  type TaxCategory,
} from "@starter/shared";
import {
  commonTaxRate,
  computeEn16931Totals,
  toCents,
  vatCents,
  type ResolvedExemptionNotes,
  type TaxedLine,
} from "./totals.js";

export type InvoiceTaxRequest = {
  tax?: LineTax | undefined;
  lineTax?: ReadonlyArray<LineTax & { key: string }> | undefined;
  taxRate?: number | null | undefined;
  exemptionNotes?: ExemptionNotes | undefined;
};

export type ResolvedInvoiceTax =
  | { kind: "resolved"; lines: Array<{ key: string } & LineTax>; notes: ResolvedExemptionNotes }
  | { kind: "unresolved" }
  | { kind: "unknownKeys"; keys: string[] };

export type InvoiceTaxDefaults = {
  client: ClientBilling | null;
  profile: BusinessProfileValues;
  locale: Locale;
};

/**
 * The category and rate of every line. Per line, the first match wins:
 *
 * 1. a `lineTax` entry with the line's key;
 * 2. `request.tax`;
 * 3. `request.taxRate > 0` → S at that rate (a client that only sends a rate);
 * 4. the client's default category (S only with a profile default rate > 0);
 * 5. a small-business profile → E;
 * 6. the profile's default category and rate (same S rule).
 *
 * A line nothing matches makes the WHOLE invoice unresolved.
 */
export function resolveInvoiceTax(
  lineKeys: readonly string[],
  request: InvoiceTaxRequest,
  defaults: InvoiceTaxDefaults,
): ResolvedInvoiceTax {
  const known = new Set(lineKeys);
  const unknown = (request.lineTax ?? [])
    .map((entry) => entry.key)
    .filter((key) => !known.has(key));
  if (unknown.length > 0) return { kind: "unknownKeys", keys: [...new Set(unknown)] };

  const overrides = new Map<string, LineTax>();
  for (const entry of request.lineTax ?? []) {
    overrides.set(entry.key, { category: entry.category, rate: entry.rate });
  }
  const invoiceWide = invoiceDefaultTax(request, defaults);

  const lines: Array<{ key: string } & LineTax> = [];
  for (const key of lineKeys) {
    const tax = overrides.get(key) ?? invoiceWide;
    if (!tax) return { kind: "unresolved" };
    lines.push({ key, category: tax.category, rate: tax.rate });
  }
  const used = new Set(lines.map((line) => line.category));
  return { kind: "resolved", lines, notes: resolveExemptionNotes(used, request.exemptionNotes, defaults) };
}

function invoiceDefaultTax(request: InvoiceTaxRequest, defaults: InvoiceTaxDefaults): LineTax | null {
  if (request.tax) return { category: request.tax.category, rate: request.tax.rate };
  if (typeof request.taxRate === "number" && request.taxRate > 0) {
    return { category: "S", rate: request.taxRate };
  }
  const { client, profile } = defaults;
  const fromCategory = (category: TaxCategory | null): LineTax | null => {
    if (category === null) return null;
    if (category !== "S") return { category, rate: 0 };
    const rate = profile.defaultTaxRate;
    return typeof rate === "number" && rate > 0 ? { category: "S", rate } : null;
  };
  const fromClient = fromCategory(client?.defaultTaxCategory ?? null);
  if (fromClient) return fromClient;
  if (profile.smallBusiness) return { category: "E", rate: 0 };
  return fromCategory(profile.defaultTaxCategory);
}

/**
 * BT-120 per used E/AE/O category: what the request typed, else for E the
 * small-business text (the profile's own, or the default in the invoice's
 * language) — and `null` for an E line of a business that is not small, whose
 * exemption only the user can cite. AE and O always get the default text.
 */
export function resolveExemptionNotes(
  used: ReadonlySet<TaxCategory>,
  requested: ExemptionNotes | undefined,
  defaults: Pick<InvoiceTaxDefaults, "profile" | "locale">,
): ResolvedExemptionNotes {
  const notes: Partial<Record<ExemptionNoteCategory, string | null>> = {};
  for (const category of EXEMPTION_NOTE_CATEGORIES) {
    if (!used.has(category)) continue;
    const typed = requested?.[category];
    if (typeof typed === "string" && typed.trim() !== "") {
      notes[category] = typed.trim();
    } else if (category === "E") {
      notes.E = defaults.profile.smallBusiness
        ? (defaults.profile.smallBusinessNote ?? DEFAULT_EXEMPTION_NOTES[defaults.locale].E)
        : null;
    } else {
      notes[category] = DEFAULT_EXEMPTION_NOTES[defaults.locale][category];
    }
  }
  return notes;
}

export type InvoiceTotals = { subtotal: number; taxAmount: number; total: number };

/**
 * Subtotal, tax and total of an invoice WITHOUT line categories. The subtotal
 * sums the already-rounded line amounts in cents; tax is charged on the
 * subtotal and rounded once, half away from zero — the same rounding as the
 * EN 16931 path. `null` means no tax line at all (0 is a real 0 %).
 */
export function invoiceTotals(
  lineItems: readonly InvoiceLineItem[],
  taxRate: number | null,
): InvoiceTotals {
  const subtotal = sumAmounts(lineItems.map((line) => line.amount));
  const taxAmount = taxRate === null || !Number.isFinite(taxRate) ? 0 : taxOn(subtotal, taxRate);
  return { subtotal, taxAmount, total: sumAmounts([subtotal, taxAmount]) };
}

function taxOn(subtotal: number, taxRate: number): number {
  try {
    const cents = vatCents(toCents(subtotal), taxRate);
    return cents === 0 ? 0 : cents / 100;
  } catch {
    // A rate with more than 2 decimals predates the EN 16931 rate rule.
    return Math.round(((subtotal * taxRate) / 100) * 100) / 100;
  }
}

export type TaxedInvoiceFigures = {
  /** With taxCategory/taxRate when resolved. */
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  /** Resolved: the rate all lines share, or null. Unresolved: the input taxRate. */
  taxRate: number | null;
  /** null when unresolved. */
  taxBreakdown: TaxBreakdownRow[] | null;
};

/** Resolved → EN 16931 totals from the categorised lines; unresolved → {@link invoiceTotals} exactly as before. */
export function applyInvoiceTax(
  lineItems: readonly InvoiceLineItem[],
  resolved: ResolvedInvoiceTax,
  fallbackTaxRate: number | null,
): TaxedInvoiceFigures {
  if (resolved.kind === "unknownKeys") {
    throw new Error(`Unknown line keys: ${resolved.keys.join(", ")}`);
  }
  if (resolved.kind === "unresolved") {
    return {
      lineItems: lineItems.map((line) => ({ ...line })),
      ...invoiceTotals(lineItems, fallbackTaxRate),
      taxRate: fallbackTaxRate,
      taxBreakdown: null,
    };
  }
  const byKey = new Map(resolved.lines.map((line) => [line.key, line]));
  const taxed: InvoiceLineItem[] = [];
  const taxedLines: TaxedLine[] = [];
  for (const line of lineItems) {
    const tax = byKey.get(line.key);
    if (!tax) throw new Error(`No tax resolved for line ${line.key}`);
    taxed.push({ ...line, taxCategory: tax.category, taxRate: tax.rate });
    taxedLines.push({ amount: line.amount, taxCategory: tax.category, taxRate: tax.rate });
  }
  const totals = computeEn16931Totals(taxedLines, resolved.notes);
  return {
    lineItems: taxed,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
    taxRate: commonTaxRate(taxedLines),
    taxBreakdown: totals.breakdown,
  };
}
