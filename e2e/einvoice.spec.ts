import { test, expect } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { closeDbConnection } from "./db-utils";
import {
  CLIENT_NAME,
  DEFAULT_CLIENT_BILLING,
  confirmCreate,
  createClientAndProject,
  downloadBytes,
  embeddedFilePayloads,
  fillBusinessProfile,
  fillClientBilling,
  money,
  openPreview,
  trackBillableHours,
} from "./invoice-helpers";

/*
 * E-invoices, end to end through the UI: business profile → client billing
 * details → tracked time → invoice with a VAT category → the two e-invoice
 * downloads, and the refusal that names the missing field.
 *
 * The files are checked by their bytes (header, root element, guideline id,
 * embedded file). The official validators are Java and run in CI through
 * scripts/einvoice-validate.mjs, never here.
 *
 * No cleanDatabase(): every test signs up a new account, so runs are isolated
 * by workspace, and a wipe would clobber a concurrent spec on the same database.
 */

const PASSWORD = "SecurePassword123!";
const LEITWEG_ID = DEFAULT_CLIENT_BILLING.reference;
const XRECHNUNG_GUIDELINE =
  "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";

let sequence = 0;
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("E-invoices", () => {
  // Three downloads and two settings screens per test: more than the default 30 s.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Erika Mustermann",
      email: uniqueEmail("einvoice"),
      password: PASSWORD,
    });
    await createClientAndProject(page);
    await trackBillableHours(page, "Workshop", "3:00:00");
  });

  test("complete billing data produces a ZUGFeRD PDF and an XRechnung", async ({ page }) => {
    await fillBusinessProfile(page);
    await fillClientBilling(page);

    // ── preview: the profile's 19 % is adopted ──────────────────────
    await openPreview(page, CLIENT_NAME);
    await expect(page.getByTestId("invoice-tax-choice")).toHaveValue("S19");
    await expect(page.getByTestId("invoice-preview-tax-row")).toHaveCount(1);
    await expect(page.getByTestId("invoice-preview-tax-row")).toContainText(money(57));
    await expect(page.getByTestId("invoice-preview-total")).toContainText(money(357));

    await confirmCreate(page);
    await expect(page.getByTestId("invoice-detail")).toBeVisible();
    const number = (await page.getByTestId("invoice-detail-number").innerText()).trim();

    const panel = page.getByTestId("einvoice-panel");
    await expect(panel).toHaveAttribute("data-ready", "true");

    // ── XRechnung: CII XML with the XRechnung guideline id ─────────
    const xrechnung = await downloadBytes(page, "invoice-download-xrechnung");
    expect(xrechnung.name).toMatch(/\.xml$/);
    const xml = xrechnung.bytes.toString("utf8");
    expect(xml).toMatch(/^(﻿)?<\?xml /);
    expect(xml).toContain("<rsm:CrossIndustryInvoice");
    expect(xml).toContain(`<ram:ID>${XRECHNUNG_GUIDELINE}</ram:ID>`);
    expect(xml).toContain(`<ram:BuyerReference>${LEITWEG_ID}</ram:BuyerReference>`);
    expect(xml).toContain("DE123456789");
    expect(xml).toContain("<ram:CategoryCode>S</ram:CategoryCode>");
    expect(xml).toContain("357.00");
    expect(xml).toContain(number);

    // ── ZUGFeRD: a PDF with factur-x.xml attached ───────────────────
    const zugferd = await downloadBytes(page, "invoice-download-zugferd");
    expect(zugferd.name).toMatch(/\.pdf$/);
    expect(zugferd.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(zugferd.bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
    const pdfText = zugferd.bytes.toString("latin1");
    expect(pdfText).toContain("factur-x.xml");
    expect(pdfText).toContain("/AFRelationship /Alternative");

    const attachments = embeddedFilePayloads(zugferd.bytes).map((bytes) => bytes.toString("utf8"));
    expect(attachments).toHaveLength(1);
    const embedded = attachments[0] ?? "";
    expect(embedded).toContain("<rsm:CrossIndustryInvoice");
    expect(embedded).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
    expect(embedded).toContain("357.00");

    // ── the plain PDF is still there, and still a PDF ───────────────
    const plain = await downloadBytes(page, "invoice-download-pdf");
    expect(plain.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(plain.bytes.toString("latin1")).not.toContain("factur-x.xml");
  });

  test("an XRechnung for a client without billing data is refused and names the field", async ({
    page,
  }) => {
    await fillBusinessProfile(page);

    // ── no client billing details at all ────────────────────────────
    await openPreview(page, CLIENT_NAME);
    await expect(page.getByTestId("invoice-preview-total")).toContainText(money(357));
    await confirmCreate(page);
    await expect(page.getByTestId("invoice-detail")).toBeVisible();
    await expect(page.getByTestId("einvoice-panel")).toHaveAttribute("data-ready", "false");

    await page.getByTestId("invoice-download-xrechnung").click();
    const buyerMissing = page.locator(
      '[data-testid="einvoice-refusal-item"][data-code="BUYER_SNAPSHOT_MISSING"]',
    );
    await expect(buyerMissing).toBeVisible();
    await expect(buyerMissing).toHaveAttribute("data-field", "invoice.recipient");
    await expect(buyerMissing).toContainText("billing details");
    await expect(buyerMissing).toContainText(CLIENT_NAME);

    // ── billing details without the buyer reference (Leitweg-ID) ────
    // A draft can be deleted, which makes its time billable again.
    await page.getByTestId("invoice-delete").click();
    await expect(page.getByTestId("invoice-delete-dialog")).toBeVisible();
    const removed = page.waitForResponse(
      (response) => response.url().includes("invoices.remove") && response.ok(),
    );
    await page.getByTestId("confirm-accept").click();
    await removed;
    await expect(page.getByTestId("invoice-detail")).toHaveCount(0);

    const clientId = await fillClientBilling(page, CLIENT_NAME, { reference: "" });
    await openPreview(page, CLIENT_NAME);
    await confirmCreate(page);
    await expect(page.getByTestId("invoice-detail")).toBeVisible();

    // The ZUGFeRD profile does not ask for a buyer reference. Downloaded
    // first: the refusal below is the last thing the panel shows, so nothing
    // between it and its assertions can replace it.
    const zugferd = await downloadBytes(page, "invoice-download-zugferd");
    expect(zugferd.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await page.getByTestId("invoice-download-xrechnung").click();

    const referenceMissing = page.locator(
      '[data-testid="einvoice-refusal-item"][data-code="BUYER_REFERENCE_MISSING"]',
    );
    await expect(referenceMissing).toBeVisible();
    await expect(referenceMissing).toHaveAttribute("data-field", "clientBilling.reference");
    await expect(referenceMissing).toContainText("Leitweg-ID");
    await expect(page.getByTestId("einvoice-panel")).toHaveAttribute("data-format", "xrechnung");
    expect(downloaded).toBe(false);

    // A ZUGFeRD download succeeding says nothing about the XRechnung refusal,
    // so the refusal stays on screen.
    await downloadBytes(page, "invoice-download-zugferd");
    await expect(referenceMissing).toBeVisible();

    // ── the fix link opens that client's billing details at the field ─
    await referenceMissing.getByTestId("einvoice-fix-link").click();
    await expect(page).toHaveURL(
      new RegExp(`/app/clients/?\\?billing=${clientId}&field=reference&from=invoice:`),
    );
    await expect(page.getByTestId("client-dialog")).toBeVisible();
    await expect(page.getByTestId("client-billing-reference")).toBeFocused();

    // ── the reverse-charge warning edits the client without losing the draft ─
    await page.getByTestId("client-cancel").click();
    await openPreview(page, CLIENT_NAME);
    await page.getByTestId("invoice-notes").fill("Kept across the client dialog");
    await page.getByTestId("invoice-tax-choice").selectOption("AE");
    await expect(page.getByTestId("invoice-tax-ae-vat-warning")).toBeVisible();
    await page.getByTestId("invoice-tax-ae-fix").click();
    await expect(page.getByTestId("client-dialog")).toBeVisible();
    await expect(page.getByTestId("client-billing-vatId")).toBeFocused();
    await page.getByTestId("client-billing-vatId").fill("ATU12345678");
    await page.getByTestId("client-submit").click();
    await expect(page.getByTestId("client-dialog")).toBeHidden();
    await expect(page.getByTestId("invoice-dialog")).toBeVisible();
    await expect(page.getByTestId("invoice-notes")).toHaveValue("Kept across the client dialog");
    await expect(page.getByTestId("invoice-tax-choice")).toHaveValue("AE");
    await expect(page.getByTestId("invoice-tax-ae-vat-warning")).toHaveCount(0);
  });
});
