// The JSON export is lossless: a client's billing details and the business
// profile go out in the file and come back when the file is read in.
//
// The database halves (`buildWorkspaceExport`, `createMissingCatalog`) map
// straight onto these shapes; what is tested here is the part that decides
// what survives the trip — the document the exporter writes, serialised, and
// read back by the same parser `data.analyze` and `data.commit` use.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORKSPACE_EXPORT_VERSION,
  type InvoiceIssuer,
  type WorkspaceExport,
} from "@starter/shared";
import { workspaceJsonCatalog } from "../services/import/parse.js";

const profile: InvoiceIssuer = {
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
});
