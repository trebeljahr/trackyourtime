import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { signUpViaUI, TRACK_URL } from "./helpers";
import { closeDbConnection, getDb } from "./db-utils";
import {
  confirmCreate, createClientAndProject, DEFAULT_CLIENT_BILLING, downloadBytes, embeddedFilePayloads, fillBusinessProfile, fillClientBilling,
  money, openPreview, trackBillableHours,
} from "./invoice-helpers";

// E-invoices in an encrypted workspace (docs/private-workspace-protocol.md →
// "Invoices in an encrypted workspace"): the check, the XML and the ZUGFeRD
// PDF are made on the device from the decrypted invoice, with the same code
// and fonts the server uses. The e2e server allows
// ENCRYPTED_WORKSPACE_USERS=@encrypted.example.

const PASSWORD = "Encrypted-Einvoice-123!";
/**
 * With E2E_EINVOICE_OUT set, the browser-made files are saved there under the
 * names `pnpm einvoice:validate --skip-generate` validates (Mustang with
 * veraPDF, KoSIT), so the device's output can go through the same Java check
 * as the server's samples.
 */
const saveForValidation = (name: string, bytes: Buffer | string): void => {
  const dir = process.env.E2E_EINVOICE_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
};
const XRECHNUNG_GUIDELINE = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";

test.afterAll(async () => {
  await closeDbConnection();
});

async function encryptedWorkspace(page: Page, name: string): Promise<void> {
  await signUpViaUI(page, { name: "Erika Mustermann", email: `enc-einv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@encrypted.example`, password: PASSWORD });
  await page.getByTestId("recovery-key-saved").click({ timeout: 20_000 });
  const switcher = page.getByTestId("workspace-switcher");
  await switcher.click();
  await page.getByTestId("workspace-create").click();
  const dialog = page.getByTestId("new-workspace-dialog");
  await dialog.getByTestId("new-workspace-name").fill(name);
  await dialog.getByTestId("new-workspace-encrypted").locator("input").check();
  await dialog.getByTestId("new-workspace-submit").click();
  await page.waitForURL(TRACK_URL, { timeout: 20_000 });
  await expect(switcher).toContainText(name, { timeout: 20_000 });
}

test.describe("Encrypted e-invoices", () => {
  test.describe.configure({ timeout: 240_000 });

  test("issues an XRechnung and a ZUGFeRD PDF on the device, and serves the issued XML unchanged", async ({ page }) => {
    const stamp = Date.now(), client = `Hidden buyer ${stamp}`, project = `Hidden build ${stamp}`;
    await encryptedWorkspace(page, `E-invoice space ${stamp}`);
    await createClientAndProject(page, client, project);
    await trackBillableHours(page, `Workshop ${stamp}`, "3:00:00", project);
    await fillBusinessProfile(page, {}, null);
    await fillClientBilling(page, client, {}, null);

    await openPreview(page, client);
    await expect(page.getByTestId("invoice-tax-choice")).toHaveValue("S19", { timeout: 20_000 });
    await expect(page.getByTestId("invoice-preview-total")).toContainText(money(357));
    await confirmCreate(page);
    await expect(page.getByTestId("invoice-detail")).toBeVisible({ timeout: 20_000 });
    const number = (await page.getByTestId("invoice-detail-number").innerText()).trim();
    await expect(page.getByTestId("einvoice-panel")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });

    // XRechnung from a draft: built fresh on the device.
    const draftXml = (await downloadBytes(page, "invoice-download-xrechnung")).bytes.toString("utf8");
    expect(draftXml).toContain("<rsm:CrossIndustryInvoice");
    expect(draftXml).toContain(`<ram:ID>${XRECHNUNG_GUIDELINE}</ram:ID>`);
    expect(draftXml).toContain(`<ram:BuyerReference>${DEFAULT_CLIENT_BILLING.reference}</ram:BuyerReference>`);
    expect(draftXml).toContain("357.00");
    expect(draftXml).toContain(number);

    // ZUGFeRD: PDF/A-3 with factur-x.xml, drawn here with the embedded Noto faces.
    const zugferd = await downloadBytes(page, "invoice-download-zugferd");
    expect(zugferd.name).toMatch(/\.pdf$/);
    expect(zugferd.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const pdfText = zugferd.bytes.toString("latin1");
    expect(pdfText).toContain("factur-x.xml");
    expect(pdfText).toContain("/AFRelationship /Alternative");
    expect(pdfText).toContain("NotoSans");
    const attachments = embeddedFilePayloads(zugferd.bytes).map((bytes) => bytes.toString("utf8"));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
    saveForValidation("browser-standard-19.zugferd.pdf", zugferd.bytes);
    saveForValidation("browser-standard-19.en16931.xml", attachments[0] ?? "");

    // Sent: the first export is stored in the encrypted invoice, and served again byte for byte.
    await page.getByTestId("invoice-status-set-sent").click();
    await expect(page.getByTestId("invoice-detail-status")).toHaveText("sent", { timeout: 20_000 });
    const issued = (await downloadBytes(page, "invoice-download-xrechnung")).bytes.toString("utf8");
    await page.reload();
    await page.locator('[data-testid^="invoice-row-"]').first().click();
    await expect(page.getByTestId("invoice-detail")).toBeVisible({ timeout: 20_000 });
    const again = (await downloadBytes(page, "invoice-download-xrechnung")).bytes.toString("utf8");
    expect(again).toBe(issued);
    saveForValidation("browser-standard-19.xrechnung.xml", issued);

    // Neither the buyer, the work nor the XML reached the database in plaintext.
    const db = await getDb();
    for (const { name } of await db.listCollections().toArray()) {
      const rows = JSON.stringify(await db.collection(name).find({}).toArray());
      expect(rows.includes(client), `client name in ${name}`).toBe(false);
      expect(rows.includes(project), `project name in ${name}`).toBe(false);
      expect(rows.includes("CrossIndustryInvoice"), `e-invoice XML in ${name}`).toBe(false);
    }
  });

  test("refuses an XRechnung for a client without billing data, and names the field", async ({ page }) => {
    const stamp = Date.now(), client = `Bare buyer ${stamp}`, project = `Bare build ${stamp}`;
    await encryptedWorkspace(page, `E-invoice refusal ${stamp}`);
    await createClientAndProject(page, client, project);
    await trackBillableHours(page, `Workshop ${stamp}`, "3:00:00", project);
    await fillBusinessProfile(page, {}, null);
    await openPreview(page, client);
    await expect(page.getByTestId("invoice-preview-total")).toContainText(money(357), { timeout: 20_000 });
    await confirmCreate(page);
    await expect(page.getByTestId("einvoice-panel")).toHaveAttribute("data-ready", "false", { timeout: 20_000 });
    await page.getByTestId("invoice-download-xrechnung").click();
    const buyerMissing = page.locator('[data-testid="einvoice-refusal-item"][data-code="BUYER_SNAPSHOT_MISSING"]');
    await expect(buyerMissing).toBeVisible({ timeout: 20_000 });
    await expect(buyerMissing).toHaveAttribute("data-field", "invoice.recipient");
  });
});
