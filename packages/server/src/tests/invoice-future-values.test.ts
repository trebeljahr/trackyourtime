// A database is shared across releases: a newer one may have stored an enum
// value this build has never heard of (a locale, an electronic address scheme,
// a tax category). Creating an invoice copies such values into the snapshot,
// and must not throw a ValidationError over something the user never typed.
// See models/README.md.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { BusinessProfileModel } from "../models/BusinessProfile.js";
import { Client } from "../models/Client.js";
import { UserPreferencesModel } from "../models/Settings.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  WORKSPACE,
  contextFor,
  seedWorkspace,
} from "./support/einvoice-db-fixture.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const INPUT = {
  from: "2026-09-01",
  to: "2026-09-30",
  groupBy: "task" as const,
  issueDate: "2026-09-30",
  dueDate: "2026-10-14",
};

const owner = () => invoicesRouter.createCaller(contextFor(OWNER));

describe("invoice create with values from a newer release", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-future-values", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("tolerates an unknown electronic address scheme and invoice locale on the client", async () => {
    const seeded = await seedWorkspace();
    // Written straight to the collection, the way a newer release's validator
    // would have let them through.
    await Client.collection.updateOne(
      { workspaceId: WORKSPACE },
      {
        $set: {
          invoiceLocale: "fr",
          "billing.electronicAddressScheme": "9999-future",
          "billing.preferredFormat": "peppol-future",
          "billing.defaultTaxCategory": "Q-future",
        },
      },
    );

    const invoice = await owner().create({ clientId: seeded.clientId, ...INPUT });

    assert.equal(invoice.locale, "en", "an unknown client locale falls through to the default");
    assert.ok(invoice.recipient, "the recipient is still snapshotted");
    // The unknown scheme reads as none, so the address defaults from the email.
    assert.equal(invoice.recipient.electronicAddressScheme, "EM");
  });

  it("tolerates an unknown issuer locale preference and profile scheme", async () => {
    const seeded = await seedWorkspace();
    await UserPreferencesModel.collection.insertOne({ userId: OWNER, locale: "fr" });
    await BusinessProfileModel.collection.updateOne(
      { workspaceId: WORKSPACE },
      { $set: { electronicAddressScheme: "9999-future", defaultTaxCategory: "Q-future" } },
    );

    const invoice = await owner().create({ clientId: seeded.clientId, ...INPUT });

    assert.equal(invoice.locale, "en");
    assert.ok(invoice.issuer);
    assert.notEqual(invoice.issuer.electronicAddressScheme, "9999-future");
  });
});
