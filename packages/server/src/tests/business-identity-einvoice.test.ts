// The e-invoice fields on main's business identity: normalisation, snapshots,
// the electronic address default, the absent-key-keeps merge, and rows written
// before any of it existed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_CLIENT_BILLING,
  emptyBusinessProfile,
  isIdentityEmpty,
  issuerSnapshot,
  mergeIdentityInput,
  normalizeBusinessProfile,
  normalizeClientBilling,
  normalizeIssuer,
  normalizeRecipient,
  recipientLegalName,
  recipientSnapshot,
  taxCategorySchema,
  withDefaultElectronicAddress,
  type BusinessProfileFields,
} from "@starter/shared";
import { BusinessProfileModel } from "../models/BusinessProfile.js";
import { Client, toClientClient } from "../models/Client.js";
import { Invoice, toClientInvoice, type InvoiceDocLike } from "../models/Invoice.js";

describe("normalising the new fields", () => {
  it("stores identifiers compact and upper case, blanks as null", () => {
    const profile = normalizeBusinessProfile({
      vatId: " de 123 456 789 ",
      iban: "de02 1203 0000 0000 2020 51",
      bic: "byladem1001",
      taxNumber: "  ",
      contactName: " Erika Mustermann ",
    });
    assert.equal(profile.vatId, "DE123456789");
    assert.equal(profile.iban, "DE02120300000000202051");
    assert.equal(profile.bic, "BYLADEM1001");
    assert.equal(profile.taxNumber, null);
    assert.equal(profile.contactName, "Erika Mustermann");
    assert.equal(profile.smallBusiness, false);
    assert.equal(profile.defaultTaxCategory, null);
    assert.equal(profile.defaultTaxRate, null);
  });

  it("keeps the electronic address pair whole or drops both halves", () => {
    const both = normalizeClientBilling({ electronicAddress: "ap@example.com", electronicAddressScheme: "EM" });
    assert.equal(both?.electronicAddress, "ap@example.com");
    assert.equal(both?.electronicAddressScheme, "EM");
    assert.equal(normalizeClientBilling({ electronicAddressScheme: "EM" }), null);
    const half = normalizeBusinessProfile({ electronicAddress: "ap@example.com" });
    assert.equal(half.electronicAddress, null);
    assert.equal(half.electronicAddressScheme, null);
  });

  it("reads unknown enum values from an old or hand-edited file as null", () => {
    const billing = normalizeClientBilling({
      city: "Berlin",
      preferredFormat: "docx" as unknown as "pdf",
      defaultTaxCategory: "X" as unknown as "S",
    });
    assert.equal(billing?.preferredFormat, null);
    assert.equal(billing?.defaultTaxCategory, null);
  });

  it("counts a client whose only billing value is a preference as having billing, but not a recipient", () => {
    const billing = normalizeClientBilling({ preferredFormat: "zugferd" });
    assert.equal(billing?.preferredFormat, "zugferd");
    assert.equal(recipientSnapshot("Example GmbH", billing), null);
  });

  it("treats false as empty, so an untouched checkbox is not a profile", () => {
    assert.equal(isIdentityEmpty({ legalName: null, addressLines: [], smallBusiness: false }), true);
    assert.equal(isIdentityEmpty({ legalName: null, smallBusiness: true }), false);
    assert.equal(issuerSnapshot({ smallBusiness: false }), null);
    assert.equal(issuerSnapshot(normalizeBusinessProfile(null)), null);
  });

  it("the empty profile carries every new key", () => {
    const empty = emptyBusinessProfile("ws");
    assert.equal(empty.vatId, null);
    assert.equal(empty.smallBusiness, false);
    assert.equal(empty.defaultTaxRate, null);
    assert.deepEqual(Object.keys(EMPTY_CLIENT_BILLING).sort(), Object.keys(normalizeClientBilling({ city: "x" }) ?? {}).sort());
  });
});

describe("snapshots", () => {
  const profile: BusinessProfileFields = {
    legalName: "Example GmbH",
    email: "billing@example.com",
    vatId: "DE123456789",
    iban: "DE02120300000000202051",
    smallBusiness: true,
    smallBusinessNote: "Kleinunternehmer",
    defaultTaxCategory: "E",
    defaultTaxRate: 0,
  };

  it("leaves the defaults and the note off the issuer snapshot", () => {
    const issuer = issuerSnapshot(profile);
    assert.ok(issuer);
    assert.equal("defaultTaxCategory" in issuer, false);
    assert.equal("defaultTaxRate" in issuer, false);
    assert.equal("smallBusinessNote" in issuer, false);
    assert.equal(issuer.smallBusiness, true);
    assert.equal(issuer.iban, "DE02120300000000202051");
  });

  it("defaults the electronic address to the email, with scheme EM, in the snapshot only", () => {
    const issuer = issuerSnapshot(profile);
    assert.equal(issuer?.electronicAddress, "billing@example.com");
    assert.equal(issuer?.electronicAddressScheme, "EM");
    assert.equal(normalizeBusinessProfile(profile).electronicAddress, null, "the stored profile stays null");

    const recipient = recipientSnapshot("Example Kunde", { city: "München", email: "ap@kunde.example" });
    assert.equal(recipient?.electronicAddress, "ap@kunde.example");
    assert.equal(recipient?.electronicAddressScheme, "EM");
  });

  it("keeps an entered electronic address over the email", () => {
    const issuer = issuerSnapshot({ ...profile, electronicAddress: "991-12345-06", electronicAddressScheme: "0204" });
    assert.equal(issuer?.electronicAddress, "991-12345-06");
    assert.equal(issuer?.electronicAddressScheme, "0204");
    assert.deepEqual(withDefaultElectronicAddress({ email: null, electronicAddress: null, electronicAddressScheme: null }), {
      email: null,
      electronicAddress: null,
      electronicAddressScheme: null,
    });
  });

  it("defaults the electronic address only from an email that is one", () => {
    const party = { email: "accounts (ask Anna)", electronicAddress: null, electronicAddressScheme: null };
    assert.deepEqual(withDefaultElectronicAddress(party), party);
    assert.equal(issuerSnapshot({ legalName: "Example GmbH", email: "accounts (ask Anna)" })?.electronicAddress, null);
  });

  it("leaves the client's defaults off the recipient snapshot", () => {
    const recipient = recipientSnapshot("Example Kunde", {
      city: "München",
      vatId: "ATU12345678",
      reference: "991-12345-06",
      preferredFormat: "xrechnung",
      defaultTaxCategory: "AE",
    });
    assert.ok(recipient);
    assert.equal("preferredFormat" in recipient, false);
    assert.equal("defaultTaxCategory" in recipient, false);
    assert.equal(recipient.vatId, "ATU12345678");
    assert.equal(recipient.reference, "991-12345-06");
  });

  it("uses the display name as BT-44 when no legal name was entered", () => {
    const recipient = normalizeRecipient({ name: "Example Kunde", city: "München" });
    assert.equal(recipientLegalName(recipient), "Example Kunde");
    assert.equal(recipientLegalName({ ...recipient, legalName: "Example Kunde GmbH" }), "Example Kunde GmbH");
  });
});

describe("merging an update over what is stored", () => {
  it("keeps a key left out and clears a key sent as null", () => {
    const stored = normalizeBusinessProfile({ legalName: "Example GmbH", iban: "DE02120300000000202051", vatId: "DE123456789" });
    const merged = normalizeBusinessProfile(
      mergeIdentityInput<BusinessProfileFields>(stored, { legalName: "Example AG", vatId: null, iban: undefined }),
    );
    assert.equal(merged.legalName, "Example AG");
    assert.equal(merged.iban, "DE02120300000000202051", "an omitted IBAN survives");
    assert.equal(merged.vatId, null, "null clears");
  });

  it("does not mutate the stored value", () => {
    const stored = { city: "Berlin", postalCode: "10115" };
    mergeIdentityInput(stored, { city: "Hamburg" });
    assert.deepEqual(stored, { city: "Berlin", postalCode: "10115" });
  });
});

describe("rows written before e-invoicing", () => {
  const legacyInvoice = (): InvoiceDocLike => ({
    _id: "64b7f9c2e13a4d5f6a7b8c9d",
    workspaceId: "ws",
    createdBy: "user",
    number: "2025-003",
    clientId: "c1",
    clientName: "Example Kunde",
    status: "sent",
    issueDate: new Date("2025-03-01T00:00:00.000Z"),
    dueDate: new Date("2025-03-15T00:00:00.000Z"),
    from: new Date("2025-02-01T00:00:00.000Z"),
    to: new Date("2025-03-01T00:00:00.000Z"),
    groupBy: "project",
    lineItems: [
      { key: "p1", label: "Website", projectId: "p1", taskId: null, seconds: 3600, hours: 1, hourlyRate: 100, currency: "EUR", amount: 100 },
    ],
    subtotal: 100,
    taxRate: 19,
    taxAmount: 19,
    total: 119,
    currency: "EUR",
    entryIds: ["e1"],
    notes: null,
    createdAt: new Date("2025-03-01T00:00:00.000Z"),
    updatedAt: new Date("2025-03-01T00:00:00.000Z"),
  });

  it("an invoice without the new fields maps exactly as before", () => {
    const wire = toClientInvoice(legacyInvoice());
    assert.deepEqual(Object.keys(wire.lineItems[0] ?? {}), [
      "key", "label", "projectId", "taskId", "seconds", "hours", "hourlyRate", "currency", "amount",
    ]);
    for (const key of ["taxBreakdown", "paymentTerms", "einvoiceFills", "einvoice"]) {
      assert.equal(key in wire, false, `${key} appeared on a legacy invoice`);
    }
  });

  it("a legacy issuer snapshot reads the new keys as null and false", () => {
    const wire = toClientInvoice({
      ...legacyInvoice(),
      issuer: {
        legalName: "Example GmbH",
        addressLines: [],
        postalCode: null,
        city: "Berlin",
        country: "DE",
        taxId: "DE123",
        email: "billing@example.com",
        phone: null,
        website: null,
        paymentDetails: null,
        paymentTermsDays: 14,
        invoiceFooter: null,
      } as unknown as NonNullable<InvoiceDocLike["issuer"]>,
    });
    assert.equal(wire.issuer?.vatId, null);
    assert.equal(wire.issuer?.smallBusiness, false);
    // Normalising a read never invents the default address: only a snapshot or a fill does.
    assert.equal(wire.issuer?.electronicAddress, null);
    assert.equal(wire.issuer?.taxId, "DE123");
  });

  it("maps the new invoice fields when present, and never the stored XML", () => {
    const wire = toClientInvoice({
      ...legacyInvoice(),
      lineItems: legacyInvoice().lineItems.map((line) => ({ ...line, taxCategory: "S" as const, taxRate: 19 })),
      taxBreakdown: [{ category: "S", rate: 19, basisAmount: 100, taxAmount: 19, exemptionReason: null, exemptionReasonCode: null }],
      paymentTerms: "Payable by 2025-03-15.",
      einvoice: {
        fills: [{ at: new Date("2026-09-14T08:00:00.000Z"), by: "user", fields: ["issuer"] }],
        issuedXml: { en16931: { xml: "<x/>", generatedAt: new Date(), generator: "g" } },
      },
    });
    assert.equal(wire.lineItems[0]?.taxCategory, "S");
    assert.equal(wire.taxBreakdown?.length, 1);
    assert.equal(wire.paymentTerms, "Payable by 2025-03-15.");
    assert.deepEqual(wire.einvoiceFills, [{ at: "2026-09-14T08:00:00.000Z", by: "user", fields: ["issuer"] }]);
    assert.equal(JSON.stringify(wire).includes("<x/>"), false);
  });

  it("legacy documents validate against the extended schemas and gain no defaults", () => {
    const invoice = new Invoice(legacyInvoice());
    assert.equal(invoice.validateSync(), undefined);
    assert.equal(invoice.taxBreakdown, undefined);
    assert.equal(invoice.paymentTerms, undefined);
    assert.equal(invoice.einvoice, undefined);
    assert.equal(invoice.lineItems[0]?.taxCategory, undefined);

    const client = new Client({ workspaceId: "ws", createdBy: "u", name: "Example Kunde", color: "#64748b", archived: false });
    assert.equal(client.validateSync(), undefined);
    assert.equal(client.billing, undefined);
    assert.equal(
      toClientClient({ ...client.toObject(), _id: "c1", createdAt: new Date(), updatedAt: new Date() }).billing,
      null,
    );

    const profile = new BusinessProfileModel({ workspaceId: "ws", legalName: "Example GmbH" });
    assert.equal(profile.validateSync(), undefined);
    assert.equal(profile.smallBusiness, false);
  });

  it("checks a line's category at the zod boundary, not on the snapshot model", () => {
    // A newer release may add a category; the invoice model must still accept
    // what it copies (models/README.md). The request schema is what refuses.
    const invoice = new Invoice({
      ...legacyInvoice(),
      lineItems: legacyInvoice().lineItems.map((line) => ({ ...line, taxCategory: "X", taxRate: 19 })),
    });
    assert.equal(invoice.validateSync()?.errors["lineItems.0.taxCategory"], undefined);
    assert.equal(taxCategorySchema.safeParse("X").success, false);
    assert.equal(taxCategorySchema.safeParse("S").success, true);
  });

  it("normalizeIssuer and normalizeBusinessProfile differ only by the defaults", () => {
    const all = Object.keys(normalizeBusinessProfile(null)).sort();
    const issuer = Object.keys(normalizeIssuer(null)).sort();
    assert.deepEqual(
      all.filter((key) => !issuer.includes(key)),
      ["defaultTaxCategory", "defaultTaxRate", "smallBusinessNote"],
    );
  });
});
