// The logo through the real procedures, against a real database: uploaded
// and removed in Settings without touching the identity or its `updatedAt`,
// frozen onto an invoice at creation (bytes and all) so that a later upload
// or removal never reaches it, drawn by the PDF export, and never added or
// changed by the e-invoice fill.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { BUSINESS_LOGO_REFUSALS, imageDataUrl } from "@starter/shared";
import { getBusinessLogo, getBusinessProfile } from "../models/BusinessProfile.js";
import { Invoice } from "../models/Invoice.js";
import { inspectLogoBytes } from "../services/invoice-logo.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { settingsRouter } from "../trpc/routers/settings.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  WORKSPACE,
  contextFor,
  insertLegacyInvoice,
  seedWorkspace,
} from "./support/einvoice-db-fixture.js";
import { pdfObjects } from "./support/pdf-bytes.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const RANGE = { from: "2026-09-01", to: "2026-09-30", groupBy: "task" as const };
const DATES = { issueDate: "2026-09-30", dueDate: "2026-10-14" };

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/logo/${name}`, import.meta.url)));
const upload = (name: string, mime: "image/png" | "image/jpeg") => ({
  mime,
  base64: fixture(name).toString("base64"),
});
const sha = (name: string): string => {
  const inspected = inspectLogoBytes(fixture(name));
  assert.ok(inspected.ok);
  return inspected.logo.sha256;
};

const settings = () => settingsRouter.createCaller(contextFor(OWNER));
const invoices = () => invoicesRouter.createCaller(contextFor(OWNER));

/** The stored issuer subdocument, raw, so a key's absence is visible. */
const storedIssuer = async (id: string): Promise<Record<string, unknown>> => {
  const raw = (await Invoice.collection.findOne({ _id: new Types.ObjectId(id) })) as {
    issuer?: Record<string, unknown>;
  } | null;
  return raw?.issuer ?? {};
};

const imageObjects = (base64: string): string[] =>
  pdfObjects(Buffer.from(base64, "base64"))
    .map((object) => object.dict)
    .filter((dict) => dict.includes("/Subtype /Image"));

describe("business logo: settings, snapshot, PDF and fill", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("invoice-logo", INTEGRATION_MODELS as never);
  });
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("stores and removes the logo without touching the identity or its updatedAt", async () => {
    await seedWorkspace();
    const before = await getBusinessProfile(WORKSPACE);
    assert.equal(before.logo, null);
    assert.ok(before.updatedAt);

    const set = await settings().setBusinessLogo(upload("rgba.png", "image/png"));
    assert.deepEqual(set.logo, {
      dataUrl: imageDataUrl(upload("rgba.png", "image/png")),
      width: 48,
      height: 16,
    });
    assert.equal(set.legalName, before.legalName);
    assert.equal(set.updatedAt, before.updatedAt);
    assert.equal((await getBusinessLogo(WORKSPACE))?.sha256, sha("rgba.png"));

    // Replacing keeps the same row and the same timestamp.
    const replaced = await settings().setBusinessLogo(upload("rgb.jpg", "image/jpeg"));
    assert.equal(replaced.logo?.dataUrl, imageDataUrl(upload("rgb.jpg", "image/jpeg")));
    assert.equal(replaced.updatedAt, before.updatedAt);

    const cleared = await settings().clearBusinessLogo({});
    assert.equal(cleared.logo, null);
    assert.equal(cleared.legalName, before.legalName);
    assert.equal(await getBusinessLogo(WORKSPACE), null);
    // Idempotent.
    assert.equal((await settings().clearBusinessLogo({})).logo, null);
  });

  it("refuses bad bytes with the stable code and writes nothing", async () => {
    await seedWorkspace();
    await assert.rejects(
      settings().setBusinessLogo(upload("cmyk.jpg", "image/jpeg")),
      (error: unknown) =>
        error instanceof TRPCError &&
        error.code === "BAD_REQUEST" &&
        error.message === BUSINESS_LOGO_REFUSALS.cmykJpeg,
    );
    await assert.rejects(
      settings().setBusinessLogo(upload("rgb.png", "image/jpeg")),
      (error: unknown) => error instanceof TRPCError && error.message === BUSINESS_LOGO_REFUSALS.unsupportedFormat,
    );
    assert.equal((await getBusinessProfile(WORKSPACE)).logo, null);
  });

  it("a workspace with no profile row gets one holding only the logo, and no invoice prints it", async () => {
    const seeded = await seedWorkspace({ profile: null });
    const profile = await settings().setBusinessLogo(upload("rgb.png", "image/png"));
    assert.equal(profile.logo?.width, 48);
    assert.equal(profile.legalName, null);
    // Never saved as an identity: the form reads null as exactly that.
    assert.equal(profile.updatedAt, null);

    const invoice = await invoices().create({ clientId: seeded.clientId, ...RANGE, ...DATES });
    // No issuer block for a logo to belong to.
    assert.equal(invoice.issuer, null);
  });

  it("freezes the logo bytes on the invoice; a later upload or removal never reaches it", async () => {
    const seeded = await seedWorkspace();
    await settings().setBusinessLogo(upload("rgba.png", "image/png"));

    const invoice = await invoices().create({ clientId: seeded.clientId, ...RANGE, ...DATES });
    assert.equal(invoice.issuer?.hasLogo, true);
    assert.equal(JSON.stringify(invoice).includes("base64"), false);
    const frozen = await storedIssuer(invoice.id);
    assert.equal((frozen.logo as { sha256: string }).sha256, sha("rgba.png"));

    await settings().setBusinessLogo(upload("rgb.jpg", "image/jpeg"));
    await settings().clearBusinessLogo({});
    assert.equal(await getBusinessLogo(WORKSPACE), null);
    assert.equal(((await storedIssuer(invoice.id)).logo as { sha256: string }).sha256, sha("rgba.png"));
    assert.equal((await invoices().get({ id: invoice.id })).issuer?.hasLogo, true);

    // The PDF is drawn from the invoice alone: the image is there although
    // the profile has no logo any more.
    const pdf = await invoices().exportPdf({ id: invoice.id });
    const images = imageObjects(pdf.base64);
    assert.equal(images.length, 2, "colour image plus its SMask");
    assert.ok(images.some((dict) => dict.includes("/Width 48")));
  });

  it("freezes the logo onto a blank invoice too: the issuer snapshot needs no range", async () => {
    const seeded = await seedWorkspace();
    await settings().setBusinessLogo(upload("rgba.png", "image/png"));

    const invoice = await invoices().create({
      clientId: seeded.clientId,
      lines: [{ label: "Retainer", quantity: 1, unit: "piece", unitPrice: 2000 }],
      ...DATES,
    });
    assert.equal(invoice.from, null);
    assert.equal(invoice.to, null);
    assert.equal(invoice.issuer?.hasLogo, true);
    assert.equal(((await storedIssuer(invoice.id)).logo as { sha256: string }).sha256, sha("rgba.png"));

    const pdf = await invoices().exportPdf({ id: invoice.id });
    assert.equal(imageObjects(pdf.base64).length, 2, "colour image plus its SMask");
  });

  it("the e-invoice fill never adds a logo, and never touches a frozen one", async () => {
    const seeded = await seedWorkspace();
    await settings().setBusinessLogo(upload("rgba.png", "image/png"));

    // A legacy invoice has no issuer at all: the fill writes one from
    // today's profile, without the logo.
    const legacyId = await insertLegacyInvoice(seeded);
    const filled = await invoices().attachEinvoiceData({ id: legacyId, confirm: true });
    assert.ok(filled.issuer?.legalName, "the fill wrote an issuer from today's profile");
    assert.equal("hasLogo" in (filled.issuer ?? {}), false);
    assert.equal(Object.hasOwn(await storedIssuer(legacyId), "logo"), false);

    // An invoice that froze a logo and lost a postcode: the fill writes the
    // postcode leaf and leaves the logo bytes where they were.
    const invoice = await invoices().create({ clientId: seeded.clientId, ...RANGE, ...DATES });
    await Invoice.updateOne({ _id: invoice.id }, { $set: { "issuer.postalCode": null } });
    await settings().setBusinessLogo(upload("rgb.jpg", "image/jpeg"));
    const refilled = await invoices().attachEinvoiceData({ id: invoice.id, confirm: true });
    assert.equal(refilled.issuer?.postalCode, "10115");
    assert.equal(refilled.issuer?.hasLogo, true);
    assert.equal(((await storedIssuer(invoice.id)).logo as { sha256: string }).sha256, sha("rgba.png"));
  });
});
