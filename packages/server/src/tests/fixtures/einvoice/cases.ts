/**
 * The e-invoice case matrix: one invoice per tax situation the serializer
 * must handle. Shared by the golden test, the CII unit tests, the PDF tests
 * and the sample generator (whose output the Java validators check).
 *
 * Placeholder data only: *.example domains, the mod-97-valid test IBAN
 * DE02120300000000202051, fictitious VAT ids of valid shape and the
 * Leitweg-ID 991-12345-06. Dates are built so the output is identical under
 * any TZ: issue/due as UTC midnight, the range as local midnight (the way the
 * router writes each of them).
 *
 * Not matched by the test glob (src/tests/*.test.ts), so nothing here runs on its own.
 */

import { fileURLToPath } from "node:url";
import {
  issuerSnapshot,
  normalizeBusinessProfile,
  normalizeClientBilling,
  recipientSnapshot,
  type BusinessProfile,
  type BusinessProfileFields,
  type ClientBilling,
  type ClientBillingFields,
  type EinvoiceProfile,
  type Invoice,
  manualLineAmount,
  type InvoiceIssuer,
  type InvoiceLineItem,
  type InvoiceLineUnit,
  type InvoiceRecipient,
  type LineTax,
  type Locale,
} from "@starter/shared";
import { applyFillPlan, planEinvoiceFill } from "../../../services/einvoice/fill.js";
import { paymentTermsSentence } from "../../../services/einvoice/payment-terms.js";
import {
  commonTaxRate,
  computeEn16931Totals,
  type ResolvedExemptionNotes,
} from "../../../services/einvoice/totals.js";

export type EinvoiceCase = {
  /** kebab-case, used in golden and sample filenames. */
  name: string;
  description: string;
  /** Which goldens exist. */
  profiles: readonly EinvoiceProfile[];
  /** A fresh object per call; tests may not share mutations. */
  invoice(): Invoice;
};

const BOTH: readonly EinvoiceProfile[] = ["en16931", "xrechnung"];

export const fixturePath = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Exemption texts as a user would have snapshotted them (not read from the shared defaults, so a copy edit there cannot move a golden). */
export const FIXTURE_NOTES = {
  smallBusinessDe: "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG.",
  reverseChargeEn: "Reverse charge: VAT is payable by the recipient.",
  notSubjectEn: "Service not subject to German VAT.",
} as const;

/** The client's display name, frozen onto every fixture invoice as `clientName` and `recipient.name`. */
export const FIXTURE_CLIENT_NAME = "Beispielkunde";

const STAMP = "2026-10-01T09:00:00.000Z";

/** The business profile every case is issued from, as the settings form would send it. */
const PROFILE_FIELDS: BusinessProfileFields = {
  legalName: "Erika Mustermann Softwareentwicklung",
  addressLines: ["Musterstraße 1"],
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  email: "erika@seller.example",
  phone: "+49 30 1234567",
  paymentTermsDays: 14,
  vatId: "DE123456789",
  taxNumber: "30/123/45678",
  contactName: "Erika Mustermann",
  electronicAddress: "invoices@seller.example",
  electronicAddressScheme: "EM",
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Beispielbank",
  accountHolder: "Erika Mustermann",
  defaultTaxCategory: "S",
  defaultTaxRate: 19,
};

/** The client billing details every case is addressed to. No electronic address: the snapshot defaults it from the email. */
const CLIENT_BILLING_FIELDS: ClientBillingFields = {
  legalName: "Beispielkunde GmbH",
  addressLines: ["Beispielweg 7"],
  postalCode: "80331",
  city: "München",
  country: "DE",
  email: "ap@buyer.example",
  reference: "PO-4711",
  preferredFormat: "zugferd",
};

/** The stored business profile (main's `BusinessProfile`), for the legacy fill. */
export function businessProfileFixture(overrides: BusinessProfileFields = {}): BusinessProfile {
  return {
    workspaceId: "ws-fixture",
    ...normalizeBusinessProfile({ ...PROFILE_FIELDS, ...overrides }),
    updatedAt: STAMP,
  };
}

/** The issuer snapshot create takes from businessProfileFixture(). */
export function issuerFixture(overrides: BusinessProfileFields = {}): InvoiceIssuer {
  const issuer = issuerSnapshot({ ...PROFILE_FIELDS, ...overrides });
  if (issuer === null) throw new Error("fixture issuer is empty");
  return issuer;
}

/** The client's stored billing details (main's `ClientBilling`), for the legacy fill. */
export function clientBillingFixture(overrides: ClientBillingFields = {}): ClientBilling {
  const billing = normalizeClientBilling({ ...CLIENT_BILLING_FIELDS, ...overrides });
  if (billing === null) throw new Error("fixture client billing is empty");
  return billing;
}

/** The recipient snapshot create takes from clientBillingFixture(). */
export function recipientFixture(overrides: ClientBillingFields = {}): InvoiceRecipient {
  const recipient = recipientSnapshot(FIXTURE_CLIENT_NAME, { ...CLIENT_BILLING_FIELDS, ...overrides });
  if (recipient === null) throw new Error("fixture recipient is empty");
  return recipient;
}

/** One hourly line. `amount` is billed from the exact seconds, as the router bills it. */
export function lineFixture(seconds: number, hourlyRate: number, tax: LineTax, label: string): InvoiceLineItem {
  return {
    key: `line-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label,
    projectId: null,
    taskId: null,
    seconds,
    hours: round2(seconds / 3600),
    hourlyRate,
    currency: "EUR",
    amount: round2((seconds / 3600) * hourlyRate),
    taxCategory: tax.category,
    taxRate: tax.rate,
  };
}

/** One manual line, priced the way `manualLineItems` prices it: `manualLineAmount`, never a float product. */
export function manualLineFixture(
  quantity: number,
  unit: InvoiceLineUnit,
  unitPrice: number,
  tax: LineTax,
  label: string,
): InvoiceLineItem {
  return {
    key: `manual:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label,
    projectId: null,
    taskId: null,
    kind: "manual",
    seconds: 0,
    hours: 0,
    hourlyRate: unitPrice,
    currency: "EUR",
    amount: manualLineAmount(quantity, unitPrice),
    quantity,
    unit,
    unitPrice,
    taxCategory: tax.category,
    taxRate: tax.rate,
  };
}

const RANGE = {
  from: new Date(2026, 8, 1).toISOString(),
  to: new Date(2026, 9, 1).toISOString(),
  issueDate: new Date(Date.UTC(2026, 9, 1)).toISOString(),
  dueDate: new Date(Date.UTC(2026, 9, 15)).toISOString(),
};

/** The invoice fields every case shares, without any e-invoice data. */
function baseInvoice(number: string, lines: InvoiceLineItem[]): Invoice {
  return {
    id: `inv-${number}`,
    workspaceId: "ws-fixture",
    createdBy: "user-fixture",
    number,
    clientId: "client-fixture",
    clientName: FIXTURE_CLIENT_NAME,
    status: "sent",
    issueDate: RANGE.issueDate,
    dueDate: RANGE.dueDate,
    from: RANGE.from,
    to: RANGE.to,
    groupBy: "project",
    lineItems: lines,
    subtotal: 0,
    taxRate: null,
    taxAmount: 0,
    total: 0,
    currency: "EUR",
    entryIds: [],
    notes: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

/** Runs computeEn16931Totals on the lines, so a fixture can never hold inconsistent totals by accident. */
export function readyInvoiceFixture(parts: {
  lines: InvoiceLineItem[];
  issuer: InvoiceIssuer;
  recipient: InvoiceRecipient;
  notes?: string | null;
  /**
   * BT-20 as create writes it, from the issuer's terms and the stored dates.
   * Pass a string only to test the XML with text no code path writes.
   */
  paymentTerms?: string;
  exemptionNotes?: ResolvedExemptionNotes;
  locale?: Locale;
  number?: string;
  /** Invoice and line currency; "EUR" when absent. */
  currency?: string;
  /** A blank invoice: no billed range (`from` and `to` null), manual lines only. */
  blank?: boolean;
}): Invoice {
  const taxed = parts.lines.map((line) => {
    if (line.taxCategory === undefined || line.taxRate === undefined) {
      throw new Error(`fixture line ${line.label} has no tax category`);
    }
    return { amount: line.amount, taxCategory: line.taxCategory, taxRate: line.taxRate };
  });
  const totals = computeEn16931Totals(taxed, parts.exemptionNotes ?? {});
  const currency = parts.currency ?? "EUR";
  return {
    ...baseInvoice(
      parts.number ?? "2026-0042",
      parts.lines.map((line) => ({ ...line, currency })),
    ),
    currency,
    ...(parts.blank ? { from: null, to: null } : {}),
    subtotal: totals.subtotal,
    taxRate: commonTaxRate(taxed),
    taxAmount: totals.taxAmount,
    total: totals.total,
    notes: parts.notes ?? null,
    ...(parts.locale === undefined ? {} : { locale: parts.locale }),
    issuer: parts.issuer,
    recipient: parts.recipient,
    taxBreakdown: totals.breakdown,
    paymentTerms:
      parts.paymentTerms ??
      paymentTermsSentence(parts.locale, parts.issuer.paymentTermsDays, RANGE.dueDate, {
        issueDateIso: RANGE.issueDate,
      }),
  };
}

// ── Legacy sources ─────────────────────────────────────────────────────────

/**
 * An invoice exactly as the router stored it before e-invoicing existed: no
 * snapshots, no line categories, a flat taxRate and totals rounded in floats.
 */
export function legacyInvoiceFixture(): Invoice {
  const lines = [
    lineFixture(45000, 95, { category: "S", rate: 19 }, "Website relaunch – development"),
    lineFixture(11700, 110, { category: "S", rate: 19 }, "Website relaunch – code review"),
  ].map(({ taxCategory: _category, taxRate: _rate, ...line }) => line);
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const taxAmount = round2(subtotal * 0.19);
  return {
    ...baseInvoice("2026-0017", lines),
    subtotal,
    taxRate: 19,
    taxAmount,
    total: round2(subtotal + taxAmount),
    notes: "Thank you for your business.",
  };
}

/** legacyInvoiceFixture after attachEinvoiceData's plan, applied with the fixture sources. */
export function legacyAttachedFixture(): Invoice {
  const legacy = legacyInvoiceFixture();
  const plan = planEinvoiceFill(
    legacy,
    { profile: businessProfileFixture(), client: { billing: clientBillingFixture() } },
    {},
  );
  if (plan.mismatch !== null || plan.needsChoice) {
    throw new Error("legacy fixture no longer fills cleanly");
  }
  return applyFillPlan(legacy, plan);
}

// ── The matrix ─────────────────────────────────────────────────────────────

const S19: LineTax = { category: "S", rate: 19 };
const S7: LineTax = { category: "S", rate: 7 };

/** A Swiss business: category O, a VAT id of valid shape that the XML must not emit (BR-O-02). */
const swissRecipient = (): InvoiceRecipient =>
  recipientFixture({
    legalName: "Beispiel AG",
    addressLines: ["Musterweg 5"],
    postalCode: "8001",
    city: "Zürich",
    country: "CH",
    vatId: "CHE123456789",
    electronicAddress: "invoices@buyer-ch.example",
    electronicAddressScheme: "EM",
  });

const standardLines = (): InvoiceLineItem[] => [
  lineFixture(45000, 95, S19, "Website relaunch – development"),
  lineFixture(11700, 110, S19, "Website relaunch – code review"),
];

export const EINVOICE_CASES: readonly EinvoiceCase[] = [
  {
    name: "standard-19",
    description: "Two hourly lines at 19 %: the business content of the validated research sample.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        lines: standardLines(),
        issuer: issuerFixture(),
        recipient: recipientFixture(),
        notes: "Leistungszeitraum 01.09.2026 bis 30.09.2026.",
      }),
  },
  {
    name: "reduced-7",
    description: "One line at the reduced 7 % rate.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0043",
        lines: [lineFixture(36000, 80, S7, "Editorial work")],
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
  {
    name: "mixed-19-7",
    description: "19 % and 7 % on one invoice: two breakdown rows, VAT ties rounded away from zero, a 6-dp quantity.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0044",
        lines: [
          lineFixture(49380, 90, S19, "Consulting"),
          lineFixture(10440, 115, S7, "Editorial work"),
        ],
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
  {
    name: "zero-rated",
    description: "Category Z at 0 %: no exemption reason (BR-Z-10).",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0045",
        lines: [lineFixture(7200, 100, { category: "Z", rate: 0 }, "Zero-rated service")],
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
  {
    name: "small-business-e",
    description: "§ 19 UStG small business: category E, no VAT id, tax number plus seller identifier (BR-CO-26), German texts.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0046",
        locale: "de",
        lines: [lineFixture(18000, 60, { category: "E", rate: 0 }, "Webentwicklung")],
        issuer: issuerFixture({ vatId: null, sellerIdentifier: "30/123/45678", smallBusiness: true }),
        recipient: recipientFixture(),
        exemptionNotes: { E: FIXTURE_NOTES.smallBusinessDe },
        notes: "Vielen Dank für Ihren Auftrag.",
      }),
  },
  {
    name: "reverse-charge-ae",
    description: "Reverse charge to an Austrian business: category AE, buyer VAT id (BR-AE-02), VATEX-EU-AE.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0047",
        lines: [lineFixture(45000, 95, { category: "AE", rate: 0 }, "Software development")],
        issuer: issuerFixture(),
        recipient: recipientFixture({
          legalName: "Beispiel Handels GmbH",
          addressLines: ["Beispielgasse 3"],
          postalCode: "1010",
          city: "Wien",
          country: "AT",
          vatId: "ATU12345678",
          electronicAddress: "invoices@buyer-at.example",
          electronicAddressScheme: "EM",
        }),
        exemptionNotes: { AE: FIXTURE_NOTES.reverseChargeEn },
      }),
  },
  {
    name: "not-subject-o",
    description: "Service not subject to VAT for a Swiss buyer: category O, no VAT ids emitted (BR-O-02), no line rate (BR-O-05).",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0048",
        lines: [lineFixture(36000, 120, { category: "O", rate: 0 }, "Architecture review")],
        issuer: issuerFixture({ registrationNumber: "HRB 123456 B" }),
        recipient: swissRecipient(),
        exemptionNotes: { O: FIXTURE_NOTES.notSubjectEn },
      }),
  },
  {
    name: "not-subject-chf",
    description: "The Swiss category O service invoiced in CHF: a plain credit transfer (BT-81 \"30\"), since SEPA (\"58\") exists only in euro.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0052",
        currency: "CHF",
        lines: [lineFixture(36000, 130, { category: "O", rate: 0 }, "Architecture review")],
        issuer: issuerFixture({ registrationNumber: "HRB 123456 B" }),
        recipient: swissRecipient(),
        exemptionNotes: { O: FIXTURE_NOTES.notSubjectEn },
      }),
  },
  {
    name: "xrechnung-leitweg",
    description: "A public buyer: Leitweg-ID as buyer reference and as electronic address (scheme 0204).",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0049",
        lines: standardLines(),
        issuer: issuerFixture(),
        recipient: recipientFixture({
          legalName: "Stadtverwaltung Beispielstadt",
          addressLines: ["Rathausplatz 1", "Amt für Digitales"],
          postalCode: "12345",
          city: "Beispielstadt",
          country: "DE",
          reference: "991-12345-06",
          electronicAddress: "991-12345-06",
          electronicAddressScheme: "0204",
        }),
      }),
  },
  {
    name: "legacy-attached",
    description: "An invoice created before e-invoicing, filled from the current business profile and client billing details.",
    profiles: BOTH,
    invoice: legacyAttachedFixture,
  },
  {
    name: "escaping",
    description: "Markup characters, non-Latin-1 text, an emoji, CR/LF, a tab and a control character.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0050",
        lines: [lineFixture(3600, 100, S19, `R&D <phase 2> "alpha" 'beta' – Größe 😀\tfinal\u0007`)],
        issuer: issuerFixture(),
        recipient: recipientFixture({ legalName: "Müller & Söhne <Test> GmbH" }),
        notes: "First line & more\r\nSecond line <b>bold</b>\r\n\u0007Third line  ",
        // Hand-written on purpose: a line break and an email address in BT-20,
        // which no sentence the router writes contains.
        paymentTerms: "Payable within 14 days.\nQuestions: billing@seller.example",
      }),
  },
  {
    name: "manual-lines",
    description: "Tracked hours (HUR) beside a workshop billed by the day (DAY) and a licence by the piece (C62), all at 19 %.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0053",
        lines: [
          lineFixture(45000, 95, S19, "Website relaunch – development"),
          manualLineFixture(2, "day", 800, S19, "Workshop"),
          manualLineFixture(1, "piece", 250, S19, "Licence"),
        ],
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
  {
    name: "blank",
    description: "A blank invoice: no billed range, so no BillingSpecifiedPeriod, and delivery on the issue date; two manual lines at 19 %.",
    profiles: BOTH,
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0054",
        blank: true,
        lines: [
          manualLineFixture(1.5, "day", 900, S19, "Consulting day"),
          manualLineFixture(3, "piece", 49.99, S19, "Support ticket"),
        ],
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
  {
    name: "long-500",
    description: "500 lines: multi-page PDF and performance. No goldens (too large to review).",
    profiles: [],
    invoice: () =>
      readyInvoiceFixture({
        number: "2026-0051",
        lines: Array.from({ length: 500 }, (_, i) =>
          lineFixture((1 + ((i * 7) % 40)) * 3600, 50 + ((i * 13) % 101), S19, `Task ${i + 1}`),
        ),
        issuer: issuerFixture(),
        recipient: recipientFixture(),
      }),
  },
];

/** The case with that name; throws for an unknown name. */
export function einvoiceCase(name: string): EinvoiceCase {
  const found = EINVOICE_CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`unknown e-invoice case: ${name}`);
  return found;
}
