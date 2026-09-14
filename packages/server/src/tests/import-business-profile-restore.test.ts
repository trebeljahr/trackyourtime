// Restoring a business profile from an import file whose values contradict the
// stored ones once merged: only the contradicting keys are left out, and
// everything else in the file is restored.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { BusinessProfileModel, getBusinessProfile, saveBusinessProfile } from "../models/BusinessProfile.js";
import { profileKeysToDrop, restoreBusinessProfile } from "../trpc/routers/data.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const WORKSPACE = "ws_import_profile_example";

describe("profileKeysToDrop", () => {
  it("drops the defaults first, then the small-business flag, then gives up", () => {
    assert.deepEqual(profileKeysToDrop("defaultTaxCategory", new Set()), ["defaultTaxCategory", "defaultTaxRate"]);
    assert.deepEqual(profileKeysToDrop("defaultTaxRate", new Set(["defaultTaxCategory", "defaultTaxRate"])), ["smallBusiness"]);
    assert.equal(
      profileKeysToDrop("defaultTaxCategory", new Set(["defaultTaxCategory", "defaultTaxRate", "smallBusiness"])),
      null,
    );
  });

  it("drops the electronic address as a pair, once", () => {
    assert.deepEqual(profileKeysToDrop("electronicAddressScheme", new Set()), ["electronicAddress", "electronicAddressScheme"]);
    assert.equal(profileKeysToDrop("electronicAddress", new Set(["electronicAddress"])), null);
  });
});

describe("restoreBusinessProfile", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("import-profile", [BusinessProfileModel] as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("restores the file's identity when its small-business flag contradicts the stored default rate", async () => {
    await saveBusinessProfile(WORKSPACE, {
      legalName: "Old Example GmbH",
      defaultTaxCategory: "S",
      defaultTaxRate: 19,
    });

    await restoreBusinessProfile(WORKSPACE, {
      legalName: "Example GmbH",
      addressLines: ["Musterstraße 1"],
      city: "Berlin",
      country: "DE",
      vatId: "DE123456789",
      iban: "DE02120300000000202051",
      smallBusiness: true,
    } as Parameters<typeof restoreBusinessProfile>[1]);

    const stored = await getBusinessProfile(WORKSPACE);
    assert.equal(stored.legalName, "Example GmbH");
    assert.deepEqual(stored.addressLines, ["Musterstraße 1"]);
    assert.equal(stored.vatId, "DE123456789");
    assert.equal(stored.iban, "DE02120300000000202051");
    // The contradiction is resolved by leaving the file's flag out.
    assert.equal(stored.defaultTaxCategory, "S");
    assert.equal(stored.defaultTaxRate, 19);
    assert.equal(stored.smallBusiness, false);
  });

  it("keeps a consistent file whole", async () => {
    await saveBusinessProfile(WORKSPACE, { defaultTaxCategory: "S", defaultTaxRate: 19 });
    await restoreBusinessProfile(WORKSPACE, {
      legalName: "Example GmbH",
      smallBusiness: true,
      defaultTaxCategory: "E",
      defaultTaxRate: 0,
    } as Parameters<typeof restoreBusinessProfile>[1]);
    const stored = await getBusinessProfile(WORKSPACE);
    assert.equal(stored.smallBusiness, true);
    assert.equal(stored.defaultTaxCategory, "E");
  });
});
