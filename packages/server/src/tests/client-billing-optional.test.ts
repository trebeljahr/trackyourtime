// A client's billing details are optional at every layer, and a client row
// written before they existed must keep loading, editing and exporting.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import {
  clientBillingSchema,
  createClientSchema,
  normalizeClientBilling,
  updateBusinessProfileSchema,
  updateClientSchema,
} from "@starter/shared";
import { Client, toClientClient } from "../models/Client.js";
import { createClient, updateClient } from "../services/catalog/clients.js";

mongoose.set("bufferCommands", false);

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
      vatId: "",
      electronicAddress: "",
      electronicAddressScheme: null,
      preferredFormat: null,
      defaultTaxCategory: null,
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

describe("client billing updates merge over what is stored", () => {
  type Lean<T> = { lean: () => Promise<T> };
  const handle = Client as unknown as {
    findOne: (filter: unknown) => { select: (fields: string) => Lean<unknown> } & Lean<unknown>;
    findOneAndUpdate: (filter: unknown, update: { $set: Record<string, unknown> }) => Lean<unknown>;
    countDocuments: (filter: unknown) => Promise<number>;
    create: (doc: Record<string, unknown>) => Promise<unknown>;
  };
  const real = {
    findOne: handle.findOne,
    findOneAndUpdate: handle.findOneAndUpdate,
    countDocuments: handle.countDocuments,
    create: handle.create,
  };
  after(() => Object.assign(handle, real));

  const ID = "64b7f9c2e13a4d5f6a7b8c01";
  const scope = { workspaceId: "ws", userId: "user" } as Parameters<typeof updateClient>[0];
  let row: Record<string, unknown> = {};
  let lastSet: Record<string, unknown> | null = null;

  handle.findOne = () => {
    const result = { lean: async () => ({ ...legacyRow, ...row, _id: ID }) };
    return { ...result, select: () => result };
  };
  handle.findOneAndUpdate = (_filter, update) => {
    lastSet = update.$set;
    row = { ...row, ...update.$set };
    return { lean: async () => ({ ...legacyRow, ...row, _id: ID }) };
  };
  handle.countDocuments = async () => 0;
  handle.create = async (doc) => ({ ...legacyRow, ...doc, _id: ID });

  it("keeps a stored VAT ID and e-invoice address that an older client leaves out", async () => {
    row = {
      billing: normalizeClientBilling({
        city: "Wien",
        vatId: "ATU12345678",
        electronicAddress: "ap@kunde.example",
        electronicAddressScheme: "EM",
      }),
    };
    const updated = await updateClient(scope, { id: ID, billing: { city: "Graz", reference: "PO-7" } });
    assert.equal(updated.billing?.city, "Graz");
    assert.equal(updated.billing?.reference, "PO-7");
    assert.equal(updated.billing?.vatId, "ATU12345678");
    assert.equal(updated.billing?.electronicAddress, "ap@kunde.example");
  });

  it("clears a field sent as null, and clears the billing whole on billing: null", async () => {
    row = { billing: normalizeClientBilling({ city: "Wien", vatId: "ATU12345678" }) };
    const cleared = await updateClient(scope, { id: ID, billing: { vatId: null } });
    assert.equal(cleared.billing?.vatId, null);
    assert.equal(cleared.billing?.city, "Wien");
    await updateClient(scope, { id: ID, billing: null });
    assert.deepEqual(lastSet, { billing: null });
  });

  it("stores no billing when the merge leaves every field blank", async () => {
    row = { billing: normalizeClientBilling({ city: "Wien" }) };
    const updated = await updateClient(scope, { id: ID, billing: { city: "" } });
    assert.equal(updated.billing, null);
  });

  it("refuses an electronic address whose scheme is neither sent nor stored", async () => {
    row = { billing: normalizeClientBilling({ city: "Wien" }) };
    await assert.rejects(
      updateClient(scope, { id: ID, billing: { electronicAddress: "ap@kunde.example" } }),
      (error: unknown) => error instanceof TRPCError && error.code === "BAD_REQUEST",
    );
    await assert.rejects(
      createClient(scope, { name: "Example Kunde", billing: { electronicAddress: "ap@kunde.example" } }),
      (error: unknown) => error instanceof TRPCError && error.code === "BAD_REQUEST",
    );
  });

  it("accepts the address when the scheme is already stored", async () => {
    row = { billing: normalizeClientBilling({ city: "Wien", electronicAddress: "old@kunde.example", electronicAddressScheme: "EM" }) };
    const updated = await updateClient(scope, { id: ID, billing: { electronicAddress: "new@kunde.example" } });
    assert.equal(updated.billing?.electronicAddress, "new@kunde.example");
    assert.equal(updated.billing?.electronicAddressScheme, "EM");
  });
});
