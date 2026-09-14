// The legacy and partial fill: what "Fill missing details" would write.
//
// An invoice is a snapshot, so the fill obeys one rule per value: a stored
// non-null value is never replaced. What it may do, after the user confirmed
// the exact list, is fill what is absent or null from TODAY's business profile
// and client billing details, give the lines of a legacy invoice their VAT
// category, and compute a breakdown from the frozen line amounts. When those
// amounts, recomputed the EN 16931 way, differ from the stored totals by a
// single cent, the plan says so and the router writes nothing at all.
//
// Pure. The router loads the sources (load.ts) and does the guarded write.
import {
  EMPTY_CLIENT_BILLING,
  issuerSnapshot,
  normalizeIssuer,
  recipientSnapshot,
  withDefaultElectronicAddress,
  type BusinessProfileValues,
  type ClientBilling,
  type EinvoiceIssue,
  type EinvoiceProfile,
  type ExemptionNotes,
  type FillLineTax,
  type Invoice,
  type InvoiceIssuer,
  type InvoiceLineItem,
  type InvoiceRecipient,
  type LineTax,
  type TaxBreakdownRow,
  type TaxCategory,
  type TotalsMismatch,
  type ZeroRateTaxCategory,
} from "@starter/shared";
import { paymentTermsSentence } from "./payment-terms.js";
import { resolveExemptionNotes } from "./resolve-tax.js";
import {
  compareStoredTotals,
  computeEn16931Totals,
  rateToBasisPoints,
  type En16931Totals,
  type TaxedLine,
} from "./totals.js";
import { validateEinvoice } from "./validate.js";

export { totalsMismatchIssue } from "./validate.js";

/** Today's data. `client` is null when the client was deleted since the invoice was made. */
export type FillSources = {
  profile: BusinessProfileValues;
  client: { billing: ClientBilling | null } | null;
};

export type FillChoice = {
  /** Category for every line of a legacy invoice issued at 0 % or without tax. */
  zeroRateCategory?: ZeroRateTaxCategory | undefined;
  /** BT-120 texts the user typed in the fill dialog. */
  exemptionNotes?: ExemptionNotes | undefined;
};

export type FillPlan = {
  /** Dotted paths that would change: "issuer", "recipient.postalCode", "lineItems[*].taxCategory", "taxBreakdown", "paymentTerms". */
  fields: string[];
  /**
   * The invoice's parts as they would read after the fill: what the preview
   * validates. An absent key is left untouched. Never written as-is — a party
   * here went through the wire normalisation, which spells out keys the stored
   * snapshot never had.
   */
  set: {
    issuer?: InvoiceIssuer;
    recipient?: InvoiceRecipient;
    lineItems?: InvoiceLineItem[];
    taxBreakdown?: TaxBreakdownRow[];
    paymentTerms?: string;
  };
  /**
   * The `$set` the router writes: a whole party only where the invoice had
   * none, otherwise exactly the dotted leaves `fields` lists (plus the
   * electronic address scheme, which travels with its address). A snapshot
   * from before a key existed keeps not having it.
   */
  writes: Record<string, unknown>;
  lineTax: FillLineTax;
  /** Set when lineTax === "fixed". */
  fixedTax: LineTax | null;
  /** lineTax === "choose" and no zeroRateCategory was given. */
  needsChoice: boolean;
  /** Stored totals differ from the EN 16931 totals of the (filled) lines. The router refuses. */
  mismatch: TotalsMismatch | null;
  /**
   * The parties the fill preview validates when no snapshot can be taken (an
   * empty profile, a client with no billing details), so the preview names the
   * missing fields rather than only "no snapshot". Never written.
   */
  previewParties: { issuer: InvoiceIssuer; recipient: InvoiceRecipient | null };
};

/**
 * Issuer keys a fill never takes from today's profile. The payment terms days
 * were agreed when the invoice was issued, and the due date they would explain
 * is frozen; today's number would print a term nobody agreed to next to it.
 */
const ISSUER_KEYS_NEVER_FILLED: ReadonlySet<string> = new Set(["paymentTermsDays"]);
const RECIPIENT_KEYS_NEVER_FILLED: ReadonlySet<string> = new Set(["name"]);

export function planEinvoiceFill(invoice: Invoice, sources: FillSources, choice: FillChoice): FillPlan {
  const fields: string[] = [];
  const set: FillPlan["set"] = {};
  const writes: Record<string, unknown> = {};

  // ── issuer ──
  const currentIssuer = issuerSnapshot(sources.profile);
  if (!invoice.issuer) {
    if (currentIssuer) {
      set.issuer = { ...currentIssuer, paymentTermsDays: null };
      writes.issuer = set.issuer;
      fields.push("issuer");
    }
  } else if (currentIssuer) {
    const { merged, filled, leaves } = fillNullLeaves(
      invoice.issuer,
      currentIssuer,
      "issuer",
      ISSUER_KEYS_NEVER_FILLED,
    );
    if (filled.length > 0) {
      set.issuer = merged;
      Object.assign(writes, leaves);
      fields.push(...filled);
    }
  }

  // ── recipient ──
  const currentRecipient = sources.client
    ? recipientSnapshot(invoice.clientName, sources.client.billing)
    : null;
  if (!invoice.recipient) {
    if (currentRecipient) {
      set.recipient = currentRecipient;
      writes.recipient = currentRecipient;
      fields.push("recipient");
    }
  } else if (currentRecipient) {
    const { merged, filled, leaves } = fillNullLeaves(
      invoice.recipient,
      { ...currentRecipient, name: invoice.recipient.name },
      "recipient",
      RECIPIENT_KEYS_NEVER_FILLED,
    );
    if (filled.length > 0) {
      set.recipient = merged;
      Object.assign(writes, leaves);
      fields.push(...filled);
    }
  }

  // ── line categories ──
  const lineTaxPlan = planLineTax(invoice, choice);
  if (lineTaxPlan.lineItems && lineTaxPlan.tax) {
    set.lineItems = lineTaxPlan.lineItems;
    // Every line gets the same category and rate: two leaves per line, and
    // nothing else of a stored line is rewritten.
    writes["lineItems.$[].taxCategory"] = lineTaxPlan.tax.category;
    writes["lineItems.$[].taxRate"] = lineTaxPlan.tax.rate;
    fields.push("lineItems[*].taxCategory");
  }

  // ── breakdown and totals ──
  const lines = set.lineItems ?? invoice.lineItems;
  const taxed = taxedLines(lines);
  let mismatch: TotalsMismatch | null = null;
  if (taxed && taxed.length > 0) {
    const locale = invoice.locale ?? "en";
    const recomputed = safeTotals(taxed);
    const stored = invoice.taxBreakdown ?? [];
    if (stored.length === 0) {
      const used = new Set(taxed.map((line) => line.taxCategory));
      const notes = resolveExemptionNotes(used, choice.exemptionNotes, { profile: sources.profile, locale });
      const withNotes = safeTotals(taxed, notes);
      if (withNotes) {
        set.taxBreakdown = withNotes.breakdown;
        writes.taxBreakdown = withNotes.breakdown;
        fields.push("taxBreakdown");
      }
    } else {
      const used = new Set(stored.map((row) => row.category));
      const notes = resolveExemptionNotes(used, choice.exemptionNotes, { profile: sources.profile, locale });
      let changed = false;
      const rows = stored.map((row, index): TaxBreakdownRow => {
        const note = notes[row.category] ?? null;
        if (row.category === "S" || row.category === "Z" || row.exemptionReason !== null || note === null) {
          return { ...row };
        }
        changed = true;
        fields.push(`taxBreakdown[${index}].exemptionReason`);
        writes[`taxBreakdown.${index}.exemptionReason`] = note;
        return { ...row, exemptionReason: note };
      });
      if (changed) set.taxBreakdown = rows;
    }
    if (recomputed) mismatch = compareStoredTotals(invoice, recomputed);
  }

  // ── payment terms (BT-20), from frozen data only ──
  if (fields.length > 0 && (invoice.paymentTerms === undefined || invoice.paymentTerms === null)) {
    set.paymentTerms = paymentTermsSentence(
      invoice.locale,
      invoice.issuer?.paymentTermsDays ?? null,
      invoice.dueDate,
      { issueDateIso: invoice.issueDate },
    );
    writes.paymentTerms = set.paymentTerms;
    fields.push("paymentTerms");
  }

  return {
    fields,
    set,
    writes,
    lineTax: lineTaxPlan.lineTax,
    fixedTax: lineTaxPlan.fixedTax,
    needsChoice: lineTaxPlan.needsChoice,
    mismatch,
    previewParties: {
      issuer:
        set.issuer ?? invoice.issuer ?? withDefaultElectronicAddress(normalizeIssuer(sources.profile)),
      recipient:
        set.recipient ??
        invoice.recipient ??
        (sources.client ? emptyRecipient(invoice.clientName) : null),
    },
  };
}

/** The invoice as it would read after the plan. Pure. */
export function applyFillPlan(invoice: Invoice, plan: FillPlan): Invoice {
  const next: Invoice = { ...invoice };
  if (plan.set.issuer !== undefined) next.issuer = plan.set.issuer;
  if (plan.set.recipient !== undefined) next.recipient = plan.set.recipient;
  if (plan.set.lineItems !== undefined) next.lineItems = plan.set.lineItems;
  if (plan.set.taxBreakdown !== undefined) next.taxBreakdown = plan.set.taxBreakdown;
  if (plan.set.paymentTerms !== undefined) next.paymentTerms = plan.set.paymentTerms;
  return next;
}

/**
 * The issues left if the plan were applied. A party no snapshot can be taken
 * for is validated from what today's data holds, so the preview names each
 * missing field; LINE_TAX_MISSING is dropped while the dialog still has to ask
 * for the category.
 */
export function previewIssuesAfterFill(
  invoice: Invoice,
  plan: FillPlan,
  profile: EinvoiceProfile,
): EinvoiceIssue[] {
  const applied = applyFillPlan(invoice, plan);
  const previewed: Invoice = {
    ...applied,
    issuer: applied.issuer ?? plan.previewParties.issuer,
    recipient: applied.recipient ?? plan.previewParties.recipient,
  };
  return validateEinvoice(previewed, profile).filter(
    (issue) => !(plan.needsChoice && issue.code === "LINE_TAX_MISSING"),
  );
}

/**
 * Leaf-wise: every null leaf of `snapshot` takes `current`'s non-null leaf,
 * and a non-null leaf is never touched. An empty array is one leaf (filled
 * whole), booleans are never filled, and the electronic address with its
 * scheme is one leaf. Returns the merged value, the dotted paths filled, and
 * the `$set` leaves that write exactly those values.
 */
export function fillNullLeaves<T extends Record<string, unknown>>(
  snapshot: T,
  current: T,
  path: string,
  skip: ReadonlySet<string> = new Set(),
): { merged: T; filled: string[]; leaves: Record<string, unknown> } {
  const merged: Record<string, unknown> = { ...snapshot };
  const filled: string[] = [];
  const leaves: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    if (skip.has(key) || key === "electronicAddressScheme") continue;
    const before = snapshot[key];
    const after = current[key];
    if (typeof after === "boolean" || after === null || after === undefined) continue;
    if (Array.isArray(after)) {
      const empty = before === undefined || before === null || (Array.isArray(before) && before.length === 0);
      if (!empty || after.length === 0) continue;
      merged[key] = [...after];
    } else if (before === null || before === undefined) {
      merged[key] = after;
      if (key === "electronicAddress") {
        merged.electronicAddressScheme = current.electronicAddressScheme;
        leaves[`${path}.electronicAddressScheme`] = current.electronicAddressScheme;
      }
    } else {
      continue;
    }
    leaves[`${path}.${key}`] = merged[key];
    filled.push(`${path}.${key}`);
  }
  return { merged: merged as T, filled, leaves };
}

// ── helpers ──────────────────────────────────────────────────────────

type LineTaxPlan = {
  lineTax: FillLineTax;
  fixedTax: LineTax | null;
  needsChoice: boolean;
  lineItems: InvoiceLineItem[] | null;
  /** The one category and rate every line gets, when lineItems is set. */
  tax?: LineTax;
};

function planLineTax(invoice: Invoice, choice: FillChoice): LineTaxPlan {
  const lines = invoice.lineItems;
  const categorised = lines.filter((line) => line.taxCategory !== undefined).length;
  if (categorised === lines.length) {
    return { lineTax: "none", fixedTax: null, needsChoice: false, lineItems: null };
  }
  if (categorised > 0) {
    return { lineTax: "inconsistent", fixedTax: null, needsChoice: false, lineItems: null };
  }
  const rate = invoice.taxRate;
  if (typeof rate === "number" && rate > 0) {
    if (!isRepresentableRate(rate)) {
      return { lineTax: "inconsistent", fixedTax: null, needsChoice: false, lineItems: null };
    }
    const fixedTax: LineTax = { category: "S", rate };
    return { lineTax: "fixed", fixedTax, needsChoice: false, lineItems: withTax(lines, fixedTax), tax: fixedTax };
  }
  if (!choice.zeroRateCategory) {
    return { lineTax: "choose", fixedTax: null, needsChoice: true, lineItems: null };
  }
  const tax: LineTax = { category: choice.zeroRateCategory, rate: 0 };
  return { lineTax: "choose", fixedTax: null, needsChoice: false, lineItems: withTax(lines, tax), tax };
}

function withTax(lines: readonly InvoiceLineItem[], tax: LineTax): InvoiceLineItem[] {
  return lines.map((line) => ({ ...line, taxCategory: tax.category, taxRate: tax.rate }));
}

function isRepresentableRate(rate: number): boolean {
  try {
    rateToBasisPoints(rate);
    return true;
  } catch {
    return false;
  }
}

/** The lines as taxed lines, or null when any line has no category. */
function taxedLines(lines: readonly InvoiceLineItem[]): TaxedLine[] | null {
  const taxed: TaxedLine[] = [];
  for (const line of lines) {
    if (line.taxCategory === undefined) return null;
    taxed.push({ amount: line.amount, taxCategory: line.taxCategory, taxRate: line.taxRate ?? 0 });
  }
  return taxed;
}

/** Totals, or null for corrupt amounts or rates (validation reports those). */
function safeTotals(
  lines: readonly TaxedLine[],
  notes: Readonly<Partial<Record<TaxCategory, string | null>>> = {},
): En16931Totals | null {
  try {
    return computeEn16931Totals(lines, notes);
  } catch {
    return null;
  }
}

function emptyRecipient(name: string): InvoiceRecipient {
  const { preferredFormat: _format, defaultTaxCategory: _category, ...party } = EMPTY_CLIENT_BILLING;
  return { ...party, addressLines: [], name };
}
