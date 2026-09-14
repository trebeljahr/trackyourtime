/**
 * The e-invoice additions to the invoice PDF, as pure helpers: one totals row
 * per VAT breakdown row, the exemption wording, the structured bank lines, and
 * the rule for when VAT ids stay off the page.
 *
 * No drawing and no words of their own: `invoice-pdf.ts` draws, and every label
 * comes from the `invoice` server catalog in the invoice's language. The plain
 * PDF and the ZUGFeRD hybrid share the renderer, so a customer who gets both
 * sees the same page.
 *
 * Every helper reads only the stored invoice. An invoice created before
 * e-invoicing has no breakdown, no exemption reasons and no bank fields on its
 * issuer snapshot, and each helper then returns nothing, so it renders exactly
 * as it always did.
 */
import type { Invoice, InvoiceIssuer } from "@starter/shared";
import type { ServerTranslator } from "../i18n/index.js";
import { sanitizePdfText } from "./pdf.js";
import type { PdfFormat } from "./pdf-format.js";

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && sanitizePdfText(value) !== "";

/**
 * True when a line is not subject to VAT (category O). Such an invoice carries
 * no VAT id for either party (BR-O-02), and cii.ts leaves out BT-31 and BT-48
 * on exactly this condition, so the printed page must not show them either:
 * the hybrid's XML is the page's "Alternative" and may not say less.
 */
export function omitsVatIds(invoice: Pick<Invoice, "lineItems">): boolean {
  return invoice.lineItems.some((line) => line.taxCategory === "O");
}

/** A totals row, in the shape `drawTotals` draws. */
export type TotalsRow = { label: string; value: string; strong: false };

/**
 * One totals row per stored breakdown row, in stored order. Every row names
 * its taxable amount (BT-116), not only a taxed one: an invoice mixing 19 %
 * with an exempt or reverse-charge part has to show the net amount of each
 * (§ 14 Abs. 4 Nr. 7 UStG). Empty for an invoice without a breakdown.
 */
export function breakdownTotalRows(
  invoice: Pick<Invoice, "taxBreakdown">,
  t: ServerTranslator<"invoice">,
  format: PdfFormat,
): TotalsRow[] {
  return (invoice.taxBreakdown ?? []).map((row) => ({
    label: t("taxRow", {
      category: row.category,
      rate: format.plain(row.rate),
      basis: format.amount(row.basisAmount),
    }),
    value: format.amount(row.taxAmount),
    strong: false,
  }));
}

/** The breakdown's exemption reasons (BT-120), cleaned, each once, in stored order. */
export function exemptionReasons(invoice: Pick<Invoice, "taxBreakdown">): string[] {
  const reasons: string[] = [];
  for (const row of invoice.taxBreakdown ?? []) {
    if (!present(row.exemptionReason)) continue;
    const text = sanitizePdfText(row.exemptionReason);
    if (!reasons.includes(text)) reasons.push(text);
  }
  return reasons;
}

/** "DE02120300000000202051" → "DE02 1203 0000 0000 2020 51". Print only; the XML has no spaces. */
export function groupIban(iban: string): string {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  return compact.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * The issuer's structured bank details, one line each: IBAN (grouped), BIC,
 * bank name, account holder. Empty when the snapshot has none, which is every
 * snapshot taken before e-invoicing: those print `paymentDetails` alone.
 */
export function bankLines(
  issuer: Pick<InvoiceIssuer, "iban" | "bic" | "bankName" | "accountHolder">,
  t: ServerTranslator<"invoice">,
): string[] {
  const lines: string[] = [];
  if (present(issuer.iban)) lines.push(t("iban", { iban: groupIban(issuer.iban) }));
  if (present(issuer.bic)) lines.push(t("bic", { bic: issuer.bic }));
  if (present(issuer.bankName)) lines.push(t("bank", { bank: issuer.bankName }));
  if (present(issuer.accountHolder)) {
    lines.push(t("accountHolder", { accountHolder: issuer.accountHolder }));
  }
  return lines;
}

/** A tax identifier without the separators people type into it: "30/123/45678" → "3012345678". */
const compactTaxId = (value: string): string => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/**
 * The tax identity lines of a party: the VAT id (not when `omitVatId`), the
 * tax number, and the legacy free-text `taxId` unless it merely repeats one of
 * those two. A snapshot with only `taxId` prints exactly as it did before
 * e-invoicing, and a fill that adds a VAT id to a snapshot whose `taxId` held
 * a tax number never takes that number off a document already sent.
 */
export function taxIdentityLines(
  party: { taxId: string | null; vatId?: string | null; taxNumber?: string | null },
  t: ServerTranslator<"invoice">,
  options: { omitVatId: boolean },
): string[] {
  const vatId = party.vatId ?? null;
  const taxNumber = party.taxNumber ?? null;
  const lines: string[] = [];
  if (present(vatId) && !options.omitVatId) lines.push(t("vatId", { vatId }));
  if (present(taxNumber)) lines.push(t("taxNumber", { taxNumber }));
  if (present(party.taxId)) {
    const legacy = compactTaxId(party.taxId);
    const repeats = [vatId, taxNumber].some(
      (value) => present(value) && compactTaxId(value) === legacy,
    );
    if (!repeats) lines.push(t("taxId", { taxId: party.taxId }));
  }
  return lines;
}
