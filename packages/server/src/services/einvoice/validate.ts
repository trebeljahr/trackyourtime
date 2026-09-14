// Every reason an invoice cannot become an e-invoice, as structured issues.
//
// Pure. Reads only the invoice as stored: its issuer and recipient snapshots,
// its lines and its frozen totals — never today's profile or client. Each
// issue names the exact input to change (`field`, after its first dot main's
// model key) and where that input lives (`fixIn`), so the client can link
// straight to it. Format checks (VAT ID shape, IBAN checksum) are not repeated:
// zod refuses bad values before they are stored, and a snapshot only copies
// stored values. The one exception is the country, whose write schema predates
// e-invoicing and accepts any two letters.
import {
  isCountryCode,
  type EinvoiceFixLocation,
  type EinvoiceIssue,
  type EinvoiceIssueCode,
  type EinvoiceProfile,
  type Invoice,
  type InvoiceIssuer,
  type InvoiceLineItem,
  type InvoiceRecipient,
  type TaxBreakdownRow,
  type TaxCategory,
  type TotalsMismatch,
} from "@starter/shared";
import { EinvoiceNotReadyError } from "./errors.js";
import {
  breakdownAmountsEqual,
  compareStoredTotals,
  computeEn16931Totals,
  formatCents,
  isLineNetConsistent,
  rateToBasisPoints,
  toCents,
  type TaxedLine,
} from "./totals.js";

/** An invoice that passed validation: both snapshots, a breakdown, every line categorised. */
export type EinvoiceReadyInvoice = Invoice & {
  issuer: InvoiceIssuer;
  recipient: InvoiceRecipient;
  taxBreakdown: TaxBreakdownRow[];
  paymentTerms: string | null;
  lineItems: Array<InvoiceLineItem & { taxCategory: TaxCategory; taxRate: number }>;
};

const PROFILE_SCREEN = "Settings → Billing → Business profile";
const FROZEN_AMOUNTS = "The amounts on this invoice are frozen. Download the plain PDF instead.";
const FILL_HINT = 'then use "Fill missing details" on this invoice.';

type SellerRule = {
  code: EinvoiceIssueCode;
  key: keyof InvoiceIssuer;
  label: string;
  rule: string;
  missing: (issuer: InvoiceIssuer) => boolean;
};

const SELLER_ADDRESS_RULES: readonly SellerRule[] = [
  { code: "SELLER_LEGAL_NAME_MISSING", key: "legalName", label: "Legal name", rule: "BR-06", missing: (i) => i.legalName === null },
  { code: "SELLER_STREET_MISSING", key: "addressLines", label: "Address line 1", rule: "§ 14 Abs. 4 Nr. 1 UStG", missing: (i) => i.addressLines.length === 0 },
  { code: "SELLER_POSTCODE_MISSING", key: "postalCode", label: "Postal code", rule: "BR-DE-4", missing: (i) => i.postalCode === null },
  { code: "SELLER_CITY_MISSING", key: "city", label: "City", rule: "BR-DE-3", missing: (i) => i.city === null },
  { code: "SELLER_COUNTRY_MISSING", key: "country", label: "Country code", rule: "BR-09", missing: (i) => i.country === null },
];

const SELLER_XRECHNUNG_RULES: readonly SellerRule[] = [
  { code: "SELLER_CONTACT_NAME_MISSING", key: "contactName", label: "Contact name", rule: "BR-DE-5", missing: (i) => i.contactName === null },
  { code: "SELLER_CONTACT_PHONE_MISSING", key: "phone", label: "Phone", rule: "BR-DE-6", missing: (i) => i.phone === null },
  { code: "SELLER_CONTACT_EMAIL_MISSING", key: "email", label: "Email", rule: "BR-DE-7", missing: (i) => i.email === null },
  { code: "SELLER_ELECTRONIC_ADDRESS_MISSING", key: "electronicAddress", label: "E-invoice address", rule: "PEPPOL-EN16931-R020", missing: (i) => i.electronicAddress === null },
  { code: "SELLER_IBAN_MISSING", key: "iban", label: "IBAN", rule: "BR-DE-1", missing: (i) => i.iban === null },
];

type BuyerRule = {
  code: EinvoiceIssueCode;
  key: keyof InvoiceRecipient;
  label: string;
  rule: string;
  missing: (recipient: InvoiceRecipient) => boolean;
};

const BUYER_ADDRESS_RULES: readonly BuyerRule[] = [
  { code: "BUYER_STREET_MISSING", key: "addressLines", label: "Address line 1", rule: "§ 14 Abs. 4 Nr. 1 UStG", missing: (r) => r.addressLines.length === 0 },
  { code: "BUYER_POSTCODE_MISSING", key: "postalCode", label: "Postal code", rule: "BR-DE-9", missing: (r) => r.postalCode === null },
  { code: "BUYER_CITY_MISSING", key: "city", label: "City", rule: "BR-DE-8", missing: (r) => r.city === null },
  { code: "BUYER_COUNTRY_MISSING", key: "country", label: "Country code", rule: "BR-11", missing: (r) => r.country === null },
];

const BUYER_XRECHNUNG_RULES: readonly BuyerRule[] = [
  { code: "BUYER_REFERENCE_MISSING", key: "reference", label: "Reference (buyer reference or Leitweg-ID)", rule: "BR-DE-15", missing: (r) => r.reference === null },
  { code: "BUYER_ELECTRONIC_ADDRESS_MISSING", key: "electronicAddress", label: "E-invoice address", rule: "PEPPOL-EN16931-R010", missing: (r) => r.electronicAddress === null },
];

/** Every issue that blocks generating `profile` from this invoice as stored, in a fixed order. */
export function validateEinvoice(invoice: Invoice, profile: EinvoiceProfile): EinvoiceIssue[] {
  const issues: EinvoiceIssue[] = [];
  const lines = invoice.lineItems;
  const categories = new Set(
    lines.map((line) => line.taxCategory).filter((c): c is TaxCategory => c !== undefined),
  );

  if (lines.length === 0) {
    issues.push(invoiceIssue("NO_LINES", "invoice.lineItems", "BR-16", `This invoice has no lines, and an e-invoice needs at least one. ${FROZEN_AMOUNTS}`));
  }

  if (invoice.issuer) {
    issues.push(...sellerIssues(invoice.issuer, categories, profile));
  } else {
    issues.push(invoiceIssue("SELLER_SNAPSHOT_MISSING", "invoice.issuer", "BR-06", `This invoice was created without your business details. Fill in ${PROFILE_SCREEN}, ${FILL_HINT}`));
  }

  if (invoice.recipient) {
    issues.push(...buyerIssues(invoice.recipient, invoice, categories, profile));
  } else {
    issues.push(invoiceIssue("BUYER_SNAPSHOT_MISSING", "invoice.recipient", "BR-07", `This invoice was created without the client's billing details. Fill in ${clientScreen(invoice.clientName)}, ${FILL_HINT}`));
  }

  issues.push(...lineIssues(invoice));
  return issues;
}

/** Narrowing guard; true iff {@link validateEinvoice} returns no issue. */
export function isEinvoiceReady(invoice: Invoice, profile: EinvoiceProfile): invoice is EinvoiceReadyInvoice {
  return validateEinvoice(invoice, profile).length === 0;
}

/** The invoice, narrowed; throws EinvoiceNotReadyError carrying every issue otherwise. */
export function assertEinvoiceReady(invoice: Invoice, profile: EinvoiceProfile): EinvoiceReadyInvoice {
  const issues = validateEinvoice(invoice, profile);
  if (issues.length > 0 || !isReadyShape(invoice)) throw new EinvoiceNotReadyError(issues);
  return { ...invoice, paymentTerms: invoice.paymentTerms ?? null };
}

function isReadyShape(invoice: Invoice): invoice is EinvoiceReadyInvoice {
  return (
    Boolean(invoice.issuer) &&
    Boolean(invoice.recipient) &&
    Array.isArray(invoice.taxBreakdown) &&
    invoice.lineItems.every((line) => line.taxCategory !== undefined && line.taxRate !== undefined)
  );
}

/** The TOTALS_MISMATCH issue, with both sets of figures in the invoice currency. */
export function totalsMismatchIssue(mismatch: TotalsMismatch, currency: string): EinvoiceIssue {
  const figures = (set: TotalsMismatch["stored"]): string =>
    `subtotal ${money(set.subtotal, currency)}, tax ${money(set.taxAmount, currency)}, total ${money(set.total, currency)}`;
  return invoiceIssue(
    "TOTALS_MISMATCH",
    "invoice.total",
    "BR-CO-10/13/14/15",
    `The stored totals (${figures(mismatch.stored)}) were rounded differently from EN 16931, which gives ${figures(mismatch.recomputed)}. The amounts on an issued invoice cannot change, so no e-invoice can be made from it. Download the plain PDF instead.`,
  );
}

// ── parties ──────────────────────────────────────────────────────────

function sellerIssues(
  issuer: InvoiceIssuer,
  categories: ReadonlySet<TaxCategory>,
  profile: EinvoiceProfile,
): EinvoiceIssue[] {
  const issues: EinvoiceIssue[] = [];
  const missing = (rule: SellerRule): EinvoiceIssue =>
    profileIssue(rule.code, rule.key, rule.rule, `${rule.label} of your business is missing. Add it in ${PROFILE_SCREEN} → ${rule.label}, ${FILL_HINT}`);

  for (const rule of SELLER_ADDRESS_RULES) {
    if (rule.missing(issuer)) issues.push(missing(rule));
  }
  if (issuer.country !== null && !isCountryCode(issuer.country)) {
    issues.push(
      profileIssue("SELLER_COUNTRY_INVALID", "country", "BR-CL-14", `"${issuer.country}" on this invoice is not an ISO 3166 country code. It is frozen on this invoice: correct it in ${PROFILE_SCREEN} → Country code for your next invoice, and download the plain PDF of this one.`),
    );
  }

  if (issuer.vatId === null && issuer.taxNumber === null) {
    issues.push(
      issuer.taxId !== null
        ? profileIssue("SELLER_TAX_ID_UNCLASSIFIED", "vatId", "BR-S-02 / § 14 Abs. 4 Nr. 2 UStG", `The tax ID "${issuer.taxId}" must be entered as a VAT ID or as a tax number. Move it in ${PROFILE_SCREEN} → VAT ID or Tax number, ${FILL_HINT}`)
        : profileIssue("SELLER_TAX_ID_MISSING", "vatId", "BR-S-02 / § 14 Abs. 4 Nr. 2 UStG", `Your business needs a VAT ID or a tax number. Add one in ${PROFILE_SCREEN} → VAT ID or Tax number, ${FILL_HINT}`),
    );
  }
  if (categories.has("AE") && issuer.vatId === null) {
    issues.push(profileIssue("SELLER_VAT_ID_REQUIRED", "vatId", "§ 14a UStG / BR-AE-02", `A reverse-charge invoice needs your VAT ID. Add it in ${PROFILE_SCREEN} → VAT ID, ${FILL_HINT}`));
  }
  // O lines never carry the seller VAT ID (BR-O-02), so BR-CO-26 needs another identifier there.
  const emitsVatId = issuer.vatId !== null && !categories.has("O");
  if (!emitsVatId && issuer.sellerIdentifier === null && issuer.registrationNumber === null) {
    issues.push(profileIssue("SELLER_IDENTIFIER_REQUIRED", "registrationNumber", "BR-CO-26", `Without a VAT ID on the invoice, your business needs a registration number or another identifier. Add one in ${PROFILE_SCREEN} → Registration number, ${FILL_HINT}`));
  }

  if (profile === "xrechnung") {
    for (const rule of SELLER_XRECHNUNG_RULES) {
      if (rule.missing(issuer)) {
        const issue = missing(rule);
        issues.push({ ...issue, message: `XRechnung: ${issue.message}` });
      }
    }
  }
  return issues;
}

function buyerIssues(
  recipient: InvoiceRecipient,
  invoice: Invoice,
  categories: ReadonlySet<TaxCategory>,
  profile: EinvoiceProfile,
): EinvoiceIssue[] {
  const issues: EinvoiceIssue[] = [];
  const screen = clientScreen(invoice.clientName);
  const missing = (rule: BuyerRule, prefix = ""): EinvoiceIssue =>
    clientIssue(invoice, rule.code, rule.key, rule.rule, `${prefix}${rule.label} of ${invoice.clientName} is missing. Add it in ${screen} → ${rule.label}, ${FILL_HINT}`);

  for (const rule of BUYER_ADDRESS_RULES) {
    if (rule.missing(recipient)) issues.push(missing(rule));
  }
  if (recipient.country !== null && !isCountryCode(recipient.country)) {
    issues.push(
      clientIssue(invoice, "BUYER_COUNTRY_INVALID", "country", "BR-CL-14", `"${recipient.country}" on this invoice is not an ISO 3166 country code. It is frozen on this invoice: correct it in ${screen} → Country code for the next invoice, and download the plain PDF of this one.`),
    );
  }
  if (categories.has("AE") && recipient.vatId === null) {
    const legacy = recipient.taxId !== null ? ` The stored tax ID "${recipient.taxId}" must be entered as the VAT ID.` : "";
    issues.push(clientIssue(invoice, "BUYER_VAT_ID_REQUIRED", "vatId", "BR-AE-02 / § 14a UStG", `A reverse-charge invoice needs the VAT ID of ${invoice.clientName}.${legacy} Add it in ${screen} → VAT ID, ${FILL_HINT}`));
  }
  if (profile === "xrechnung") {
    for (const rule of BUYER_XRECHNUNG_RULES) {
      if (rule.missing(recipient)) issues.push(missing(rule, "XRechnung: "));
    }
  }
  return issues;
}

// ── lines and amounts ────────────────────────────────────────────────

function lineIssues(invoice: Invoice): EinvoiceIssue[] {
  const issues: EinvoiceIssue[] = [];
  const lines = invoice.lineItems;
  const uncategorised = lines.filter((line) => line.taxCategory === undefined).length;
  if (uncategorised > 0) {
    const subject =
      uncategorised === lines.length
        ? "No line of this invoice has a VAT category."
        : `${uncategorised} of ${lines.length} lines of this invoice have no VAT category.`;
    issues.push(
      invoiceIssue("LINE_TAX_MISSING", "invoice.lineItems", "BR-CO-04", `${subject} Use "Fill missing details" on this invoice.`),
    );
  }

  let ratesValid = true;
  lines.forEach((line, index) => {
    if (line.taxCategory === undefined) return;
    if (!isValidLineRate(line.taxCategory, line.taxRate)) {
      ratesValid = false;
      issues.push(
        invoiceIssue("LINE_TAX_RATE_INVALID", `invoice.lineItems[${index}].taxRate`, `BR-${line.taxCategory}-05`, `Line ${index + 1} ("${line.label}") has category ${line.taxCategory} at ${String(line.taxRate)} %: the standard rate needs a rate above 0 with at most 2 decimals, every other category 0 %. ${FROZEN_AMOUNTS}`),
      );
    }
  });

  const categories = new Set(lines.map((line) => line.taxCategory).filter((c) => c !== undefined));
  if (categories.has("O") && categories.size > 1) {
    issues.push(invoiceIssue("CATEGORY_O_MIXED", "invoice.lineItems", "BR-O-11", `An invoice with lines not subject to VAT cannot have lines of any other VAT category. ${FROZEN_AMOUNTS}`));
  }

  for (const row of invoice.taxBreakdown ?? []) {
    if (row.category === "S" || row.category === "Z") continue;
    if (row.exemptionReason === null || row.exemptionReason.trim() === "") {
      issues.push(invoiceIssue("EXEMPTION_NOTE_MISSING", `invoice.exemptionNotes.${row.category}`, `BR-${row.category}-10`, `The VAT exemption reason for category ${row.category} is missing. Enter it with "Fill missing details" on this invoice.`));
    }
  }

  if (!/^[A-Z]{3}$/.test(invoice.currency)) {
    issues.push(invoiceIssue("CURRENCY_INVALID", "invoice.currency", "BR-CL-04", `"${invoice.currency}" is not an ISO 4217 currency code. ${FROZEN_AMOUNTS}`));
  }
  lines.forEach((line, index) => {
    if (line.currency !== invoice.currency) {
      issues.push(invoiceIssue("LINE_CURRENCY_MISMATCH", `invoice.lineItems[${index}].currency`, "BR-05", `Line ${index + 1} ("${line.label}") is in ${line.currency}, the invoice in ${invoice.currency}. ${FROZEN_AMOUNTS}`));
    }
  });
  lines.forEach((line, index) => {
    if (!safeLineNetConsistent(line)) {
      issues.push(invoiceIssue("LINE_AMOUNT_INCONSISTENT", `invoice.lineItems[${index}].amount`, "PEPPOL-EN16931-R120", `Line ${index + 1} ("${line.label}") does not equal its hours times its rate to the cent. ${FROZEN_AMOUNTS}`));
    }
  });

  if (lines.length > 0 && uncategorised === 0 && ratesValid) {
    issues.push(...amountIssues(invoice));
  }
  return issues;
}

function amountIssues(invoice: Invoice): EinvoiceIssue[] {
  const taxed: TaxedLine[] = invoice.lineItems.flatMap((line) =>
    line.taxCategory === undefined
      ? []
      : [{ amount: line.amount, taxCategory: line.taxCategory, taxRate: line.taxRate ?? 0 }],
  );
  let recomputed: ReturnType<typeof computeEn16931Totals>;
  try {
    recomputed = computeEn16931Totals(taxed, {});
  } catch {
    return [
      invoiceIssue("TOTALS_MISMATCH", "invoice.total", "BR-DEC-23", `The line amounts of this invoice are not whole cents. ${FROZEN_AMOUNTS}`),
    ];
  }
  const issues: EinvoiceIssue[] = [];
  if (!invoice.taxBreakdown || !breakdownAmountsEqual(invoice.taxBreakdown, recomputed.breakdown)) {
    issues.push(invoiceIssue("BREAKDOWN_MISMATCH", "invoice.taxBreakdown", "BR-CO-17 / BR-S-08", `The stored VAT breakdown does not match the lines. ${FROZEN_AMOUNTS}`));
  }
  const mismatch = compareStoredTotals(invoice, recomputed);
  if (mismatch) issues.push(totalsMismatchIssue(mismatch, invoice.currency));
  return issues;
}

function isValidLineRate(category: TaxCategory, rate: number | undefined): boolean {
  if (typeof rate !== "number") return false;
  try {
    const basisPoints = rateToBasisPoints(rate);
    return category === "S" ? basisPoints > 0 : basisPoints === 0;
  } catch {
    return false;
  }
}

function safeLineNetConsistent(line: InvoiceLineItem): boolean {
  try {
    return isLineNetConsistent(line.seconds, line.hourlyRate, line.amount);
  } catch {
    return false;
  }
}

// ── issue builders ───────────────────────────────────────────────────

function clientScreen(clientName: string): string {
  return `Clients → ${clientName} → Edit → Billing details`;
}

function money(amount: number, currency: string): string {
  try {
    return `${formatCents(toCents(amount))} ${currency}`;
  } catch {
    return `${String(amount)} ${currency}`;
  }
}

function issue(
  code: EinvoiceIssueCode,
  fixIn: EinvoiceFixLocation,
  field: string,
  rule: string | null,
  message: string,
): EinvoiceIssue {
  return { code, field, message, fixIn, rule };
}

function invoiceIssue(code: EinvoiceIssueCode, field: string, rule: string | null, message: string): EinvoiceIssue {
  return issue(code, "invoice", field, rule, message);
}

function profileIssue(code: EinvoiceIssueCode, key: keyof InvoiceIssuer, rule: string | null, message: string): EinvoiceIssue {
  return issue(code, "businessProfile", `businessProfile.${key}`, rule, message);
}

function clientIssue(
  invoice: Invoice,
  code: EinvoiceIssueCode,
  key: keyof InvoiceRecipient,
  rule: string | null,
  message: string,
): EinvoiceIssue {
  return { ...issue(code, "clientBilling", `clientBilling.${key}`, rule, message), clientId: invoice.clientId };
}
