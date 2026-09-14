// A client's billing details are optional at every layer, and a client row
// written before they existed must keep loading, editing and exporting.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientBillingSchema,
  createClientSchema,
  normalizeClientBilling,
  updateBusinessProfileSchema,
  updateClientSchema,
} from "@starter/shared";
import { Client, toClientClient } from "../models/Client.js";

const legacyRow = {
  workspaceId: "ws",
  createdBy: "user",
  name: "Acme GmbH",
  color: "#64748b",
  archived: false,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-01T00:00:00.000Z"),
};

describe("client billing is optional", () => {
  it("a legacy client document with no billing subdocument validates", () => {
    const doc = new Client(legacyRow);
    assert.equal(doc.validateSync(), undefined);
    // No default is invented on read, so saving it back writes nothing new.
    assert.equal(doc.billing, undefined);
  });

  it("a legacy client reads as billing: null", () => {
    assert.equal(toClientClient({ ...legacyRow, _id: "c1" }).billing, null);
  });

  it("a client carrying billing details validates and reads them back", () => {
    const billing = normalizeClientBilling({
      legalName: "Acme Holding GmbH",
      addressLines: ["Industriestr. 4"],
      city: "Hamburg",
      country: "de",
      reference: "PO-7",
    });
    const doc = new Client({ ...legacyRow, billing });
    assert.equal(doc.validateSync(), undefined);
    const wire = toClientClient({ ...legacyRow, _id: "c1", billing });
    assert.equal(wire.billing?.country, "DE");
    assert.equal(wire.billing?.postalCode, null);
    assert.equal(wire.billing?.reference, "PO-7");
  });

  it("create and update validate without billing, and update may clear it", () => {
    assert.ok(createClientSchema.safeParse({ name: "Acme" }).success);
    assert.ok(updateClientSchema.safeParse({ id: "c1", name: "Acme" }).success);
    const cleared = updateClientSchema.parse({ id: "c1", billing: null });
    assert.equal(cleared.billing, null);
  });

  it("a form's blank fields are accepted and collapse to no billing details", () => {
    const blank = {
      legalName: "",
      addressLines: ["", ""],
      postalCode: "",
      city: "",
      country: "",
      taxId: "",
      email: "",
      reference: "",
    };
    assert.ok(clientBillingSchema.safeParse(blank).success);
    assert.equal(normalizeClientBilling(blank), null);
  });

  it("refuses a country that is not a two-letter code", () => {
    assert.equal(clientBillingSchema.safeParse({ country: "Germany" }).success, false);
    assert.equal(
      updateBusinessProfileSchema.safeParse({ paymentTermsDays: -1 }).success,
      false,
    );
  });
});
