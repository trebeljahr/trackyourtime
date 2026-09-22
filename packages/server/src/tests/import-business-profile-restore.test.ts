// Restoring a business profile from an import file whose values contradict the
// stored ones once merged: only the contradicting keys are left out, and
// everything else in the file is restored.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

describe("restoreBusinessProfile and the logo", { skip: skipWithoutDatabase }, () => {
  const png = readFileSync(fileURLToPath(new URL("./fixtures/logo/rgb.png", import.meta.url)));
  const jpeg = readFileSync(fileURLToPath(new URL("./fixtures/logo/rgb.jpg", import.meta.url)));
  const dataUrl = (bytes: Buffer, mime: string): string => `data:${mime};base64,${bytes.toString("base64")}`;
  type Restored = Parameters<typeof restoreBusinessProfile>[1];

  before(async () => {
    await connectTestDatabase("import-profile-logo", [BusinessProfileModel] as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("restores the file's logo beside the identity, and only under the key", async () => {
    await restoreBusinessProfile(WORKSPACE, {
      legalName: "Example GmbH",
      logo: dataUrl(png, "image/png"),
    } as Restored);
    const stored = await getBusinessProfile(WORKSPACE);
    assert.equal(stored.legalName, "Example GmbH");
    assert.deepEqual(stored.logo, { dataUrl: dataUrl(png, "image/png"), width: 48, height: 16 });

    // A file with no logo key leaves the stored logo alone.
    await restoreBusinessProfile(WORKSPACE, { legalName: "Example AG" } as Restored);
    const kept = await getBusinessProfile(WORKSPACE);
    assert.equal(kept.legalName, "Example AG");
    assert.equal(kept.logo?.dataUrl, dataUrl(png, "image/png"));

    // A file whose logo the invoice could not print leaves it alone too.
    await restoreBusinessProfile(WORKSPACE, { logo: dataUrl(png, "image/jpeg") } as Restored);
    assert.equal((await getBusinessProfile(WORKSPACE)).logo?.dataUrl, dataUrl(png, "image/png"));

    // A JPEG replaces it; an explicit null clears it.
    await restoreBusinessProfile(WORKSPACE, { logo: dataUrl(jpeg, "image/jpeg") } as Restored);
    assert.equal((await getBusinessProfile(WORKSPACE)).logo?.dataUrl, dataUrl(jpeg, "image/jpeg"));
    await restoreBusinessProfile(WORKSPACE, { logo: null } as Restored);
    assert.equal((await getBusinessProfile(WORKSPACE)).logo, null);
  });

  it("a logo-only file creates no identity row of its own", async () => {
    await restoreBusinessProfile(WORKSPACE, { logo: dataUrl(png, "image/png") } as Restored);
    const stored = await getBusinessProfile(WORKSPACE);
    assert.equal(stored.logo?.width, 48);
    assert.equal(stored.legalName, null);
    assert.equal(stored.updatedAt, null);
  });
});
