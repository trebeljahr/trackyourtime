/**
 * UN/CEFACT CII (D16B, as profiled by EN 16931) for an invoice that passed
 * `assertEinvoiceReady`. One serializer for both outputs: ZUGFeRD's embedded
 * `factur-x.xml` (profile "en16931") and XRechnung 3.0 CII ("xrechnung").
 *
 * Rules this file keeps, each of which a validator enforces and nothing else
 * would notice:
 *
 * - The two profiles differ in BT-24 (the guideline id) and in nothing else.
 *   What a profile *requires* is decided in validate.ts, never here.
 * - Element order is the XSD `xs:sequence` (research-standards §1.1). In
 *   `ram:ApplicableTradeTax`, ExemptionReason precedes BasisAmount and
 *   ExemptionReasonCode follows CategoryCode.
 * - No empty element (PEPPOL-EN16931-R008): `el()` drops blank leaves and
 *   childless parents, so optional terms are passed in unconditionally.
 * - Every figure is read from the snapshot. Amounts are
 *   `formatCents(toCents(x))`, rates `formatPercent`, quantities
 *   `billedHoursQuantity`. Nothing is recomputed; the invariants below throw
 *   when the stored figures disagree with each other.
 * - Deterministic: no clock, no ids, no locale. Same input → same bytes.
 */

import {
  INVOICE_LINE_UNIT_CODES,
  lineUnit,
  lineUnitPrice,
  recipientLegalName,
  type EinvoiceProfile,
  type ElectronicAddressScheme,
  type InvoiceIssuer,
  type InvoiceRecipient,
  type TaxBreakdownRow,
} from "@starter/shared";
import {
  BUSINESS_PROCESS_ID,
  GUIDELINE_IDS,
  INVOICE_TYPE_CODE,
  PAYMENT_MEANS_CREDIT_TRANSFER,
} from "./constants.js";
import {
  cleanLine,
  cleanText,
  formatDecimal,
  formatPercent,
  lastBilledDateKey,
  localDateKey,
  safeFilenamePart,
  utcDateKey,
} from "./format.js";
import { billedQuantity, formatCents, isLineConsistent, toCents } from "./totals.js";
import type { EinvoiceReadyInvoice } from "./validate.js";
import { el, render, type XmlNode } from "./xml.js";

/** The serializer was handed figures that would produce an invalid file. A bug upstream, never a user error. */
export class CiiInvariantError extends Error {
  override readonly name = "CiiInvariantError";
}

const NAMESPACES: Readonly<Record<string, string>> = {
  "xmlns:rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  "xmlns:ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  "xmlns:qdt": "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
  "xmlns:udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
};

type ReadyLine = EinvoiceReadyInvoice["lineItems"][number];

// ── Invariants ─────────────────────────────────────────────────────────────

function fail(invariant: string, detail: string): never {
  throw new CiiInvariantError(`CII invariant ${invariant}: ${detail}`);
}

function must(node: XmlNode | null, what: string): XmlNode {
  if (node === null) fail("required-element", `${what} would be empty`);
  return node;
}

/** toCents, with corrupt (more than 2-dp or non-finite) data reported as an invariant. */
function cents(value: number, what: string): number {
  try {
    return toCents(value);
  } catch (error) {
    return fail("amount-2dp (BR-DEC)", `${what} is not a 2-decimal amount: ${String(value)} (${String(error)})`);
  }
}

const taxKey = (category: string, rate: number): string => `${category}:${formatPercentOr(rate)}`;

function formatPercentOr(rate: number): string {
  try {
    return formatPercent(rate);
  } catch {
    return fail("1 (tax rate)", `rate ${String(rate)} is not a percent with at most 2 decimals`);
  }
}

const TAX_CATEGORY_CODES: ReadonlySet<string> = new Set(["S", "Z", "E", "AE", "O"]);
const ZERO_RATE: ReadonlySet<string> = new Set(["Z", "E", "AE", "O"]);
const PAYMENT_TERMS_DISCOUNT_LINE = /^\s*#/m;

/** Defence in depth behind validate.ts. Throws CiiInvariantError naming the first broken rule. */
export function assertCiiInvariants(invoice: EinvoiceReadyInvoice): void {
  // 1. Lines exist, and every line carries a known category and a well-formed rate.
  if (invoice.lineItems.length === 0) fail("1 (BR-16)", "the invoice has no lines");
  const lineTaxes = invoice.lineItems.map((line, index) => {
    // Read as unknown: the type says these are present, and this is the check that they are.
    const category: unknown = line.taxCategory;
    const rate: unknown = line.taxRate;
    if (typeof category !== "string" || !TAX_CATEGORY_CODES.has(category)) {
      return fail("1 (BR-CO-04)", `line ${index + 1} has no tax category`);
    }
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      return fail("1 (tax rate)", `line ${index + 1} has no finite tax rate`);
    }
    formatPercentOr(rate);
    if (ZERO_RATE.has(category) !== (rate === 0)) {
      fail("1 (tax rate)", `line ${index + 1} has category ${category} with rate ${rate}`);
    }
    return { category, rate };
  });

  // 2. Σ line amounts = subtotal (BR-CO-10, BR-CO-13: no document allowances/charges).
  const lineCents = invoice.lineItems.map((line, index) => cents(line.amount, `line ${index + 1} amount`));
  const lineSum = lineCents.reduce((sum, value) => sum + value, 0);
  const subtotal = cents(invoice.subtotal, "subtotal");
  if (lineSum !== subtotal) {
    fail("2 (BR-CO-10)", `line amounts sum to ${formatCents(lineSum)}, subtotal is ${formatCents(subtotal)}`);
  }

  // 3. Σ breakdown tax = taxAmount, subtotal + taxAmount = total (BR-CO-14, BR-CO-15).
  if (invoice.taxBreakdown.length === 0) fail("3 (BR-CO-18)", "the invoice has no VAT breakdown");
  const taxSum = invoice.taxBreakdown.reduce((sum, row, index) => sum + cents(row.taxAmount, `breakdown row ${index + 1} tax`), 0);
  const taxAmount = cents(invoice.taxAmount, "taxAmount");
  if (taxSum !== taxAmount) {
    fail("3 (BR-CO-14)", `breakdown tax sums to ${formatCents(taxSum)}, taxAmount is ${formatCents(taxAmount)}`);
  }
  const total = cents(invoice.total, "total");
  if (subtotal + taxAmount !== total) {
    fail("3 (BR-CO-15)", `subtotal ${formatCents(subtotal)} + tax ${formatCents(taxAmount)} ≠ total ${formatCents(total)}`);
  }

  // 4. Every breakdown row's basis is the sum of its lines, and every line has a row (BR-S-08, BR-CO-18).
  const basisByKey = new Map<string, number>();
  lineTaxes.forEach((tax, index) => {
    const key = taxKey(tax.category, tax.rate);
    basisByKey.set(key, (basisByKey.get(key) ?? 0) + (lineCents[index] ?? 0));
  });
  const rowKeys = new Set<string>();
  invoice.taxBreakdown.forEach((row, index) => {
    const key = taxKey(row.category, row.rate);
    if (rowKeys.has(key)) fail("4 (BR-CO-18)", `breakdown has two rows for ${key}`);
    rowKeys.add(key);
    const basis = cents(row.basisAmount, `breakdown row ${index + 1} basis`);
    const expected = basisByKey.get(key);
    if (expected === undefined) fail("4 (BR-CO-18)", `breakdown row ${key} has no lines`);
    if (expected !== basis) {
      fail("4 (BR-S-08)", `breakdown row ${key} basis is ${formatCents(basis)}, its lines sum to ${formatCents(expected)}`);
    }
  });
  for (const key of basisByKey.keys()) {
    if (!rowKeys.has(key)) fail("4 (BR-CO-18)", `lines with ${key} have no breakdown row`);
  }

  // 5. Quantity × price ≈ line amount (PEPPOL-EN16931-R120), for a time line
  //    (hours from its seconds) and a manual line (its stored quantity) alike.
  invoice.lineItems.forEach((line, index) => {
    if (!isLineConsistent(line)) {
      fail("5 (PEPPOL-EN16931-R120)", `line ${index + 1}: ${billedQuantity(line)} × ${lineUnitPrice(line)} does not give ${line.amount}`);
    }
  });

  // 6. BR-DE-18 reads a payment-terms line starting with "#" as a discount term.
  if (PAYMENT_TERMS_DISCOUNT_LINE.test(cleanText(invoice.paymentTerms))) {
    fail("6 (BR-DE-18)", "paymentTerms line starts with #");
  }
}

// ── Builders ───────────────────────────────────────────────────────────────

const amount = (value: number, what: string): string => formatCents(cents(value, what));

function dateTime(wrapper: string, key: string): XmlNode | null {
  return el(wrapper, [el("udt:DateTimeString", key, { format: "102" })]);
}

function documentContext(guidelineId: string): XmlNode {
  return must(
    el("rsm:ExchangedDocumentContext", [
      el("ram:BusinessProcessSpecifiedDocumentContextParameter", [el("ram:ID", BUSINESS_PROCESS_ID)]),
      el("ram:GuidelineSpecifiedDocumentContextParameter", [el("ram:ID", guidelineId)]),
    ]),
    "ExchangedDocumentContext",
  );
}

function exchangedDocument(invoice: EinvoiceReadyInvoice): XmlNode {
  return must(
    el("rsm:ExchangedDocument", [
      must(el("ram:ID", cleanLine(invoice.number)), "BT-1 invoice number"),
      el("ram:TypeCode", INVOICE_TYPE_CODE),
      must(dateTime("ram:IssueDateTime", utcDateKey(invoice.issueDate)), "BT-2 issue date"),
      el("ram:IncludedNote", [el("ram:Content", cleanText(invoice.notes))]),
    ]),
    "ExchangedDocument",
  );
}

function lineItem(line: ReadyLine, index: number): XmlNode {
  return must(
    el("ram:IncludedSupplyChainTradeLineItem", [
      el("ram:AssociatedDocumentLineDocument", [el("ram:LineID", String(index + 1))]),
      el("ram:SpecifiedTradeProduct", [must(el("ram:Name", cleanLine(line.label)), `BT-153 name of line ${index + 1}`)]),
      el("ram:SpecifiedLineTradeAgreement", [
        el("ram:NetPriceProductTradePrice", [el("ram:ChargeAmount", netPrice(lineUnitPrice(line), index))]),
      ]),
      // BT-129 / BT-130: a time line's hours (HUR) from its exact seconds, a
      // manual line's quantity in its own unit. A line from before manual
      // lines existed reads as a time line and serialises as it always did.
      el("ram:SpecifiedLineTradeDelivery", [
        el("ram:BilledQuantity", billedQuantity(line), { unitCode: INVOICE_LINE_UNIT_CODES[lineUnit(line)] }),
      ]),
      el("ram:SpecifiedLineTradeSettlement", [
        el("ram:ApplicableTradeTax", [
          el("ram:TypeCode", "VAT"),
          el("ram:CategoryCode", line.taxCategory),
          // BR-O-05: a line not subject to VAT carries no rate.
          line.taxCategory === "O" ? null : el("ram:RateApplicablePercent", formatPercent(line.taxRate)),
        ]),
        el("ram:SpecifiedTradeSettlementLineMonetarySummation", [
          el("ram:LineTotalAmount", amount(line.amount, `line ${index + 1} amount`)),
        ]),
      ]),
    ]),
    `line ${index + 1}`,
  );
}

function netPrice(unitPrice: number, index: number): string {
  try {
    return formatDecimal(unitPrice);
  } catch {
    return fail("5 (BR-27)", `line ${index + 1} has an invalid net price ${String(unitPrice)}`);
  }
}

/** The postal fields both parties share (main's flat identity shape). */
type PostalParty = Pick<InvoiceIssuer, "addressLines" | "postalCode" | "city" | "country">;

/**
 * TradeAddress = PostcodeCode?, LineOne?, LineTwo?, LineThree?, CityName?, CountryID — always in this order.
 * `addressLines[0]` is BT-35/BT-50, `[1]` BT-36/BT-51, and every further line is joined into BT-162/BT-163.
 */
function postalAddress(address: PostalParty, party: string): XmlNode {
  const lines = address.addressLines.map(cleanLine).filter((line) => line !== "");
  return must(
    el("ram:PostalTradeAddress", [
      el("ram:PostcodeCode", cleanLine(address.postalCode)),
      el("ram:LineOne", lines[0] ?? ""),
      el("ram:LineTwo", lines[1] ?? ""),
      el("ram:LineThree", lines.slice(2).join(", ")),
      el("ram:CityName", cleanLine(address.city)),
      must(el("ram:CountryID", cleanLine(address.country)), `${party} country code`),
    ]),
    `${party} address`,
  );
}

/** BT-34 / BT-49. The snapshot stores the pair both set or both null (the email default is applied at snapshot time). */
function electronicAddress(value: string | null, scheme: ElectronicAddressScheme | null): XmlNode | null {
  if (scheme === null) return null;
  return el("ram:URIUniversalCommunication", [el("ram:URIID", cleanLine(value), { schemeID: scheme })]);
}

function taxRegistration(id: string | null, scheme: "VA" | "FC"): XmlNode | null {
  return el("ram:SpecifiedTaxRegistration", [el("ram:ID", cleanLine(id), { schemeID: scheme })]);
}

function sellerParty(seller: InvoiceIssuer, hasNotSubject: boolean): XmlNode {
  return must(
    el("ram:SellerTradeParty", [
      el("ram:ID", cleanLine(seller.sellerIdentifier)),
      must(el("ram:Name", cleanLine(seller.legalName)), "BT-27 seller name"),
      el("ram:SpecifiedLegalOrganization", [el("ram:ID", cleanLine(seller.registrationNumber))]),
      el("ram:DefinedTradeContact", [
        el("ram:PersonName", cleanLine(seller.contactName)),
        el("ram:TelephoneUniversalCommunication", [el("ram:CompleteNumber", cleanLine(seller.phone))]),
        el("ram:EmailURIUniversalCommunication", [el("ram:URIID", cleanLine(seller.email))]),
      ]),
      postalAddress(seller, "seller"),
      electronicAddress(seller.electronicAddress, seller.electronicAddressScheme),
      // BR-O-02: an invoice with category O carries no VAT identifier.
      hasNotSubject ? null : taxRegistration(seller.vatId, "VA"),
      taxRegistration(seller.taxNumber, "FC"),
    ]),
    "SellerTradeParty",
  );
}

function buyerParty(buyer: InvoiceRecipient, hasNotSubject: boolean): XmlNode {
  return must(
    el("ram:BuyerTradeParty", [
      must(el("ram:Name", cleanLine(recipientLegalName(buyer))), "BT-44 buyer name"),
      postalAddress(buyer, "buyer"),
      electronicAddress(buyer.electronicAddress, buyer.electronicAddressScheme),
      hasNotSubject ? null : taxRegistration(buyer.vatId, "VA"),
    ]),
    "BuyerTradeParty",
  );
}

function headerAgreement(invoice: EinvoiceReadyInvoice, hasNotSubject: boolean): XmlNode {
  return must(
    el("ram:ApplicableHeaderTradeAgreement", [
      el("ram:BuyerReference", cleanLine(invoice.recipient.reference)),
      sellerParty(invoice.issuer, hasNotSubject),
      buyerParty(invoice.recipient, hasNotSubject),
    ]),
    "ApplicableHeaderTradeAgreement",
  );
}

/**
 * BT-72 is always written: Factur-X warns (BR-FX-EN-04) on a period without
 * it, and the CII schema requires the delivery block, which must not be empty
 * (PEPPOL-EN16931-R008). A ranged invoice delivers on its last billed day; a
 * BLANK one has no period, and its supply date is its issue date — the
 * § 14 UStG reading of an invoice that names no other day.
 */
function headerDelivery(invoice: EinvoiceReadyInvoice): XmlNode {
  const delivered = invoice.to === null ? utcDateKey(invoice.issueDate) : lastBilledDateKey(invoice.to);
  return must(
    el("ram:ApplicableHeaderTradeDelivery", [
      el("ram:ActualDeliverySupplyChainEvent", [dateTime("ram:OccurrenceDateTime", delivered)]),
    ]),
    "ApplicableHeaderTradeDelivery",
  );
}

/** UNTDID 4461 "30": a credit transfer that is not a SEPA one. */
const PAYMENT_MEANS_NON_SEPA_CREDIT_TRANSFER = "30";

/**
 * BT-81 from the stored currency. A SEPA credit transfer ("58") exists only in
 * euro, so any other currency declares a plain credit transfer ("30"). No
 * validator checks the pairing, which is why it is decided here and pinned by
 * a non-euro golden case.
 */
export function paymentMeansCode(currency: string): string {
  return cleanLine(currency).toUpperCase() === "EUR"
    ? PAYMENT_MEANS_CREDIT_TRANSFER
    : PAYMENT_MEANS_NON_SEPA_CREDIT_TRANSFER;
}

function paymentMeans(seller: InvoiceIssuer, currency: string): XmlNode | null {
  // BG-16 is written only with an account to pay into: a credit transfer code without BT-84 is meaningless.
  if (cleanLine(seller.iban) === "") return null;
  return el("ram:SpecifiedTradeSettlementPaymentMeans", [
    el("ram:TypeCode", paymentMeansCode(currency)),
    el("ram:PayeePartyCreditorFinancialAccount", [
      el("ram:IBANID", cleanLine(seller.iban)),
      el("ram:AccountName", cleanLine(seller.accountHolder)),
    ]),
    el("ram:PayeeSpecifiedCreditorFinancialInstitution", [el("ram:BICID", cleanLine(seller.bic))]),
  ]);
}

/** TradeTax = CalculatedAmount, TypeCode, ExemptionReason?, BasisAmount, CategoryCode, ExemptionReasonCode?, RateApplicablePercent. */
function breakdownTax(row: TaxBreakdownRow, index: number): XmlNode {
  return must(
    el("ram:ApplicableTradeTax", [
      el("ram:CalculatedAmount", amount(row.taxAmount, `breakdown row ${index + 1} tax`)),
      el("ram:TypeCode", "VAT"),
      el("ram:ExemptionReason", cleanText(row.exemptionReason)),
      el("ram:BasisAmount", amount(row.basisAmount, `breakdown row ${index + 1} basis`)),
      el("ram:CategoryCode", row.category),
      el("ram:ExemptionReasonCode", cleanLine(row.exemptionReasonCode)),
      // Category O: "0.00" in both profiles (BR-DE-14 needs it; the CEN rules accept it).
      el("ram:RateApplicablePercent", formatPercent(row.category === "O" ? 0 : row.rate)),
    ]),
    `breakdown row ${index + 1}`,
  );
}

/** BG-14, only on an invoice with a billed range: a blank invoice writes no period. */
function billingPeriod(invoice: EinvoiceReadyInvoice): XmlNode | null {
  if (invoice.from === null || invoice.to === null) return null;
  return el("ram:BillingSpecifiedPeriod", [
    dateTime("ram:StartDateTime", localDateKey(invoice.from)),
    dateTime("ram:EndDateTime", lastBilledDateKey(invoice.to)),
  ]);
}

function paymentTerms(invoice: EinvoiceReadyInvoice): XmlNode | null {
  return el("ram:SpecifiedTradePaymentTerms", [
    el("ram:Description", cleanText(invoice.paymentTerms)),
    dateTime("ram:DueDateDateTime", utcDateKey(invoice.dueDate)),
  ]);
}

function monetarySummation(invoice: EinvoiceReadyInvoice): XmlNode {
  const subtotal = amount(invoice.subtotal, "subtotal");
  const total = amount(invoice.total, "total");
  return must(
    el("ram:SpecifiedTradeSettlementHeaderMonetarySummation", [
      el("ram:LineTotalAmount", subtotal),
      el("ram:TaxBasisTotalAmount", subtotal),
      el("ram:TaxTotalAmount", amount(invoice.taxAmount, "taxAmount"), { currencyID: cleanLine(invoice.currency) }),
      el("ram:GrandTotalAmount", total),
      el("ram:DuePayableAmount", total),
    ]),
    "SpecifiedTradeSettlementHeaderMonetarySummation",
  );
}

function headerSettlement(invoice: EinvoiceReadyInvoice): XmlNode {
  return must(
    el("ram:ApplicableHeaderTradeSettlement", [
      el("ram:PaymentReference", cleanLine(invoice.number)),
      must(el("ram:InvoiceCurrencyCode", cleanLine(invoice.currency)), "BT-5 currency"),
      paymentMeans(invoice.issuer, invoice.currency),
      ...invoice.taxBreakdown.map(breakdownTax),
      billingPeriod(invoice),
      paymentTerms(invoice),
      monetarySummation(invoice),
    ]),
    "ApplicableHeaderTradeSettlement",
  );
}

function ciiDocument(invoice: EinvoiceReadyInvoice, guidelineId: string): XmlNode {
  const hasNotSubject = invoice.lineItems.some((line) => line.taxCategory === "O");
  return must(
    el(
      "rsm:CrossIndustryInvoice",
      [
        documentContext(guidelineId),
        exchangedDocument(invoice),
        must(
          el("rsm:SupplyChainTradeTransaction", [
            ...invoice.lineItems.map(lineItem),
            headerAgreement(invoice, hasNotSubject),
            headerDelivery(invoice),
            headerSettlement(invoice),
          ]),
          "SupplyChainTradeTransaction",
        ),
      ],
      NAMESPACES,
    ),
    "CrossIndustryInvoice",
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * UN/CEFACT CII D16B-compatible XML for an invoice that passed assertEinvoiceReady(invoice, profile).
 * Deterministic: the same invoice and profile always give byte-identical output. Only BT-24 differs by profile.
 * Reads every amount from the snapshot and never recomputes a rate or amount.
 */
export function buildCiiXml(invoice: EinvoiceReadyInvoice, profile: EinvoiceProfile): string {
  assertCiiInvariants(invoice);
  return render(ciiDocument(invoice, GUIDELINE_IDS[profile]));
}

/** "xrechnung-<sanitised number>.xml" */
export function xrechnungFilename(invoiceNumber: string): string {
  return `xrechnung-${safeFilenamePart(invoiceNumber)}.xml`;
}
