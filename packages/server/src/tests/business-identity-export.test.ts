// The JSON export is lossless: a client's billing details and the business
// profile go out in the file and come back when the file is read in.
//
// The database halves (`buildWorkspaceExport`, `createMissingCatalog`) map
// straight onto these shapes; what is tested here is the part that decides
// what survives the trip — the document the exporter writes, serialised, and
// read back by the same parser `data.analyze` and `data.commit` use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_EXPORT_VERSION,
  type BusinessProfileValues,
  type WorkspaceExport,
} from "@starter/shared";
import { workspaceJsonCatalog } from "../services/import/parse.js";

const profile: BusinessProfileValues = {
  legalName: "Alice Consulting",
  addressLines: ["Hauptstr. 1"],
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  taxId: "DE123456789",
  email: "billing@example.com",
  phone: "+49 30 1234",
  website: "https://example.com",
  paymentDetails: "IBAN DE00 1234\nBIC TESTDEFF",
  paymentTermsDays: 14,
  invoiceFooter: "Thank you.",
  vatId: "DE123456789",
  taxNumber: "12/345/67890",
  registrationNumber: "HRB 12345",
  sellerIdentifier: null,
  contactName: "Alice Example",
  electronicAddress: "billing@example.com",
  electronicAddressScheme: "EM",
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Example Bank",
  accountHolder: "Alice Consulting",
  smallBusiness: false,
  smallBusinessNote: null,
  defaultTaxCategory: "S",
  defaultTaxRate: 19,
};

const exported = (overrides: Partial<WorkspaceExport> = {}): WorkspaceExport => ({
  version: WORKSPACE_EXPORT_VERSION,
  exportedAt: "2026-09-14T08:00:00.000Z",
  workspaceId: "ws-source",
  currency: "EUR",
  settings: { defaultHourlyRate: 90, weekStartsOn: 1 },
  businessProfile: profile,
  clients: [
    {
      name: "Acme GmbH",
      color: "#111111",
      archived: false,
      billing: {
        legalName: "Acme Holding GmbH",
        addressLines: ["Industriestr. 4"],
        postalCode: "20095",
        city: "Hamburg",
        country: "DE",
        taxId: "DE555",
        email: null,
        reference: "PO-7",
        vatId: "DE987654321",
        electronicAddress: "991-12345-67",
        electronicAddressScheme: "0204",
        preferredFormat: "xrechnung",
        defaultTaxCategory: "AE",
      },
    },
    { name: "No Billing Ltd", color: "#222222", archived: false },
  ],
  projects: [],
  tasks: [],
  tags: [],
  entries: [],
  favorites: [],
  invoices: [],
  ...overrides,
});

const roundTrip = (document: WorkspaceExport): WorkspaceExport => {
  const read = workspaceJsonCatalog(JSON.stringify(document));
  assert.ok(read, "the parser refused an export it wrote itself");
  return read;
};

describe("business identity export round trip", () => {
  it("restores client billing details and the business profile", () => {
    const original = exported();
    const read = roundTrip(original);
    assert.deepEqual(read.businessProfile, original.businessProfile);
    assert.deepEqual(read.clients[0]?.billing, original.clients[0]?.billing);
  });

  it("a client without billing details comes back without them", () => {
    const read = roundTrip(exported());
    assert.equal(read.clients[1]?.name, "No Billing Ltd");
    assert.equal(read.clients[1]?.billing, undefined);
  });

  it("a file older than business identity reads exactly as before", () => {
    const { businessProfile: _profile, ...older } = exported();
    void _profile;
    const read = roundTrip({
      ...older,
      clients: [{ name: "Acme GmbH", color: "#111111", archived: false }],
    });
    assert.equal("businessProfile" in read, false);
    assert.deepEqual(read.clients, [
      { name: "Acme GmbH", color: "#111111", archived: false },
    ]);
  });

  it("malformed identity values degrade to blank instead of failing the file", () => {
    const text = JSON.stringify({
      ...exported(),
      businessProfile: { legalName: 42, country: "Germany", paymentTermsDays: "soon", city: "Berlin" },
      clients: [{ name: "Acme", color: "#111111", archived: false, billing: "nope" }],
    });
    const read = workspaceJsonCatalog(text);
    assert.ok(read);
    assert.equal(read.businessProfile?.city, "Berlin");
    assert.equal(read.businessProfile?.legalName, null);
    assert.equal(read.businessProfile?.country, null);
    assert.equal(read.businessProfile?.paymentTermsDays, null);
    assert.equal(read.clients[0]?.billing, undefined);
  });

  it("a profile written before e-invoicing leaves the e-invoice keys OUT, so the restore keeps stored values", () => {
    const older = {
      legalName: "Alice Consulting",
      addressLines: ["Hauptstr. 1"],
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
      taxId: "DE123456789",
      email: "billing@example.com",
      phone: null,
      website: null,
      paymentDetails: null,
      paymentTermsDays: 14,
      invoiceFooter: null,
    };
    const read = workspaceJsonCatalog(JSON.stringify({ ...exported(), businessProfile: older }));
    assert.ok(read?.businessProfile);
    for (const key of ["vatId", "iban", "bic", "electronicAddress", "smallBusiness", "defaultTaxRate"]) {
      assert.equal(key in read.businessProfile, false, `${key} must stay absent`);
    }
    assert.equal(read.businessProfile.taxId, "DE123456789");
  });

  it("invalid e-invoice values degrade to null instead of dropping the profile or the client", () => {
    const text = JSON.stringify({
      ...exported(),
      businessProfile: {
        ...profile,
        iban: "DE00 1234",
        bic: "nope",
        vatId: "123",
        electronicAddress: "not an email",
        electronicAddressScheme: "EM",
        // S needs a rate above 0: the pair contradicts itself and goes as a pair.
        defaultTaxCategory: "S",
        defaultTaxRate: 0,
      },
      clients: [
        {
          name: "Acme",
          color: "#111111",
          archived: false,
          billing: {
            city: "Hamburg",
            vatId: "??",
            electronicAddressScheme: "XX",
            electronicAddress: "x@example.com",
            preferredFormat: "fax",
            defaultTaxCategory: "Q",
          },
        },
      ],
    });
    const read = workspaceJsonCatalog(text);
    assert.ok(read?.businessProfile);
    const p = read.businessProfile;
    assert.deepEqual(
      [p.iban, p.bic, p.vatId, p.electronicAddress, p.electronicAddressScheme, p.defaultTaxCategory, p.defaultTaxRate],
      [null, null, null, null, null, null, null],
    );
    assert.equal(p.legalName, "Alice Consulting");
    const billing = read.clients[0]?.billing;
    assert.equal(billing?.city, "Hamburg");
    assert.deepEqual(
      [billing?.vatId, billing?.electronicAddress, billing?.electronicAddressScheme, billing?.preferredFormat, billing?.defaultTaxCategory],
      [null, null, null, null, null],
    );
  });
});

describe("the logo in the export file", () => {
  const png = readFileSync(fileURLToPath(new URL("./fixtures/logo/rgb.png", import.meta.url)));
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  it("round-trips a PNG data URL beside the identity", () => {
    const read = roundTrip(exported({ businessProfile: { ...profile, logo: dataUrl } }));
    assert.equal(read.businessProfile?.logo, dataUrl);
    assert.equal(read.businessProfile?.legalName, "Alice Consulting");
  });

  it("keeps a profile that holds only a logo, and an explicit null", () => {
    const onlyLogo = workspaceJsonCatalog(JSON.stringify({ ...exported(), businessProfile: { logo: dataUrl } }));
    // Main's keys are read as they always were (blank), and the logo beside them.
    assert.equal(onlyLogo?.businessProfile?.logo, dataUrl);
    assert.equal(onlyLogo?.businessProfile?.legalName, null);
    const cleared = roundTrip(exported({ businessProfile: { ...profile, logo: null } }));
    assert.equal(cleared.businessProfile?.logo, null);
  });

  it("leaves out a logo the invoice could not print, and never turns it into null", () => {
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zy8+",
      `data:image/jpeg;base64,${png.toString("base64")}`,
      "data:image/png;base64,iVBORw0KGgo=",
      "https://example.com/logo.png",
      42,
    ]) {
      const read = workspaceJsonCatalog(
        JSON.stringify({ ...exported(), businessProfile: { ...profile, logo: bad } }),
      );
      assert.ok(read?.businessProfile);
      assert.equal("logo" in read.businessProfile, false, String(bad));
      assert.equal(read.businessProfile.legalName, "Alice Consulting");
    }
  });

  it("a file without the key says nothing about the logo", () => {
    assert.equal("logo" in (roundTrip(exported()).businessProfile ?? {}), false);
  });
});
