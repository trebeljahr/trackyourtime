// A complete, e-invoice-ready invoice built only from F1's own functions, for
// the validate and fill tests. Synthetic data throughout.
import {
  issuerSnapshot,
  normalizeBusinessProfile,
  normalizeClientBilling,
  recipientSnapshot,
  type BusinessProfileFields,
  type BusinessProfileValues,
  type ClientBilling,
  type ClientBillingFields,
  type Invoice,
  type InvoiceLineItem,
  type LineTax,
} from "@starter/shared";
import { applyInvoiceTax, resolveInvoiceTax } from "../../services/einvoice/resolve-tax.js";
import { paymentTermsSentence } from "../../services/einvoice/payment-terms.js";

export const PROFILE_FIELDS: BusinessProfileFields = {
  legalName: "Example Softwareentwicklung GmbH",
  addressLines: ["Musterstraße 1"],
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  email: "billing@example.com",
  phone: "+49 30 1234567",
  paymentTermsDays: 14,
  vatId: "DE123456789",
  taxNumber: "30/123/45678",
  registrationNumber: "HRB 12345 B",
  contactName: "Erika Mustermann",
  electronicAddress: "invoices@example.com",
  electronicAddressScheme: "EM",
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Example Bank",
  accountHolder: "Example Softwareentwicklung GmbH",
  defaultTaxCategory: "S",
  defaultTaxRate: 19,
};

export const CLIENT_BILLING_FIELDS: ClientBillingFields = {
  legalName: "Example Kunde GmbH",
  addressLines: ["Beispielweg 7"],
  postalCode: "80331",
  city: "München",
  country: "DE",
  email: "ap@kunde.example",
  reference: "991-12345-06",
  vatId: "DE987654321",
  electronicAddress: "991-12345-06",
  electronicAddressScheme: "0204",
  preferredFormat: "xrechnung",
};

export function profileValues(overrides: BusinessProfileFields = {}): BusinessProfileValues {
  return normalizeBusinessProfile({ ...PROFILE_FIELDS, ...overrides });
}

export function clientBilling(overrides: ClientBillingFields = {}): ClientBilling {
  const billing = normalizeClientBilling({ ...CLIENT_BILLING_FIELDS, ...overrides });
  if (!billing) throw new Error("fixture billing is empty");
  return billing;
}

/** 12.5 h at 95 and 3.25 h at 110: amounts consistent with hours × rate. */
export function fixtureLines(): InvoiceLineItem[] {
  return [
    { key: "project:a", label: "Development", projectId: "a", taskId: null, seconds: 45000, hours: 12.5, hourlyRate: 95, currency: "EUR", amount: 1187.5 },
    { key: "project:b", label: "Code review", projectId: "b", taskId: null, seconds: 11700, hours: 3.25, hourlyRate: 110, currency: "EUR", amount: 357.5 },
  ];
}

const BASE: Omit<Invoice, "lineItems" | "subtotal" | "taxAmount" | "total" | "taxRate"> = {
  id: "64b7f9c2e13a4d5f6a7b8c9d",
  workspaceId: "ws",
  createdBy: "user",
  number: "2026-0042",
  clientId: "64b7f9c2e13a4d5f6a7b8c01",
  clientName: "Example Kunde",
  status: "sent",
  issueDate: "2026-09-14T00:00:00.000Z",
  dueDate: "2026-09-28T00:00:00.000Z",
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  groupBy: "project",
  currency: "EUR",
  entryIds: ["e1", "e2"],
  notes: null,
  createdAt: "2026-09-14T08:00:00.000Z",
  updatedAt: "2026-09-14T08:00:00.000Z",
};

/** An invoice as the F2 create path would store it: snapshots, categorised lines, breakdown, BT-20. */
export function readyInvoice(
  tax: LineTax = { category: "S", rate: 19 },
  options: { profile?: BusinessProfileFields; client?: ClientBillingFields; lines?: InvoiceLineItem[] } = {},
): Invoice {
  const lines = options.lines ?? fixtureLines();
  const profile = profileValues(options.profile);
  const resolved = resolveInvoiceTax(
    lines.map((l) => l.key),
    { tax },
    { profile, client: clientBilling(options.client), locale: "en" },
  );
  const figures = applyInvoiceTax(lines, resolved, null);
  const issuer = issuerSnapshot(profile);
  const recipient = recipientSnapshot(BASE.clientName, clientBilling(options.client));
  return {
    ...BASE,
    lineItems: figures.lineItems,
    subtotal: figures.subtotal,
    taxAmount: figures.taxAmount,
    total: figures.total,
    taxRate: figures.taxRate,
    ...(figures.taxBreakdown ? { taxBreakdown: figures.taxBreakdown } : {}),
    issuer,
    recipient,
    paymentTerms: paymentTermsSentence("en", issuer?.paymentTermsDays ?? null, BASE.dueDate, {
      issueDateIso: BASE.issueDate,
    }),
  };
}

/** An invoice exactly as main stored it before e-invoicing: no snapshots, no categories. */
export function legacyInvoice(taxRate: number | null = 19): Invoice {
  const lines = fixtureLines();
  const subtotal = 1545;
  const taxAmount = taxRate === null ? 0 : Math.round(subtotal * taxRate) / 100;
  return {
    ...BASE,
    lineItems: lines,
    subtotal,
    taxRate,
    taxAmount,
    total: Math.round((subtotal + taxAmount) * 100) / 100,
    issuer: null,
    recipient: null,
  };
}
