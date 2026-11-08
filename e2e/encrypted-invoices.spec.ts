import { test, expect, type Page } from "@playwright/test";
import { logManualEntry, signUpViaUI, TRACK_URL } from "./helpers";
import { closeDbConnection, getDb } from "./db-utils";
import { confirmCreate, downloadBytes, idFromTestId, money, pickComboboxOption, PROJECT_RATE, RANGE_FROM, RANGE_TO } from "./invoice-helpers";

// Invoices in an encrypted workspace (docs/private-workspace-protocol.md →
// "Invoices in an encrypted workspace"). The server never sees the invoice:
// the device computes the preview, writes the invoice and the entries' invoice
// stamps in one signed change, and draws the PDF itself. The e2e server allows
// ENCRYPTED_WORKSPACE_USERS=@encrypted.example.

const PASSWORD = "Encrypted-Invoice-123!";
const STAMP = Date.now();
const WORK = `Secret build ${STAMP}`;
const CLIENT = `Hidden client ${STAMP}`;
const PROJECT = `Hidden project ${STAMP}`;

test.afterAll(async () => {
  await closeDbConnection();
});

async function encryptedWorkspace(page: Page, name: string): Promise<void> {
  await signUpViaUI(page, { name: "Enc", email: `enc-inv-${Date.now()}@encrypted.example`, password: PASSWORD });
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

/**
 * A full page load into an encrypted workspace remounts the app once, when
 * its first private read lands (PrivateWorkspaceBoundary's view epoch), and a
 * dialog opened before that closes. So every step here waits for the page's
 * reads to finish before it touches a form; the shared invoice helpers do not.
 */
async function settledGoto(page: Page, path: string, testId: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}

async function createClientAndProject(page: Page, clientName: string, projectName: string): Promise<void> {
  await settledGoto(page, "/app/projects", "projects-page");
  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("project-dialog")).toBeVisible();
  await page.getByTestId("project-name-input").fill(projectName);
  await page.getByTestId("project-client-combobox").click();
  await page.getByTestId("combobox-search").fill(clientName);
  await page.getByTestId("combobox-create").click();
  await expect(page.getByTestId("project-client-combobox")).toContainText(clientName);
  await page.getByTestId("project-advanced-toggle").click();
  await page.getByTestId("project-rate-input").fill(PROJECT_RATE);
  await page.getByTestId("project-submit").click();
  await expect(page.getByTestId("project-dialog")).toBeHidden();
  const row = page.locator('[data-testid^="project-row-"]').filter({ hasText: projectName });
  await expect(row).toHaveCount(1);
  await idFromTestId(row, "project-row-");
}

async function trackBillableHours(page: Page, description: string, duration: string, projectName: string): Promise<void> {
  await settledGoto(page, "/app/track", "track-page");
  await pickComboboxOption(page, "tracker-project", projectName);
  await expect(page.getByTestId("tracker-billable")).toHaveAttribute("data-billable", "true");
  await logManualEntry(page, description, duration);
}

async function openPreview(page: Page, clientName: string): Promise<void> {
  await settledGoto(page, "/app/invoices", "invoices-page");
  await page.getByTestId("new-invoice").click();
  await expect(page.getByTestId("invoice-dialog")).toBeVisible();
  await pickComboboxOption(page, "invoice-client-combobox", clientName);
  await page.getByTestId("invoice-range").click();
  await expect(page.getByTestId("invoice-range-content")).toBeVisible();
  await page.getByTestId("invoice-range-from").fill(RANGE_FROM);
  await page.getByTestId("invoice-range-to").fill(RANGE_TO);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("invoice-range-content")).toBeHidden();
  await expect(page.getByTestId("invoice-dialog")).toBeVisible();
}

test("invoices tracked time on the device, bills it once, draws the PDF and stores no plaintext", async ({ page }) => {
  // Signup, key setup, an encrypted workspace and two invoices: well past the 30 s default.
  test.setTimeout(240_000);
  const space = `Invoice space ${Date.now()}`;
  await encryptedWorkspace(page, space);
  await createClientAndProject(page, CLIENT, PROJECT);
  await trackBillableHours(page, WORK, "3:00:00", PROJECT);

  // Preview: three hours at 100, computed from the decrypted copy.
  await openPreview(page, CLIENT);
  const lines = page.getByTestId("invoice-preview-line");
  await expect(lines).toHaveCount(1, { timeout: 20_000 });
  await expect(lines.first()).toContainText("3.00 h");
  await expect(page.getByTestId("invoice-preview-total")).toContainText(money(300));

  await confirmCreate(page);
  await expect(page.getByTestId("invoice-detail")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("invoice-detail-client")).toContainText(CLIENT);
  await expect(page.getByTestId("invoice-detail-status")).toHaveText("draft");
  await expect(page.getByTestId("invoice-detail-total")).toContainText(money(300));
  await expect(page.getByTestId("invoices-count")).toHaveText("1 invoice");

  // The PDF is drawn here, from the encrypted record alone.
  const pdf = await downloadBytes(page, "invoice-download-pdf");
  expect(pdf.name).toMatch(/^invoice-.+\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  // Billed once: the same range has nothing left to bill.
  await openPreview(page, CLIENT);
  await expect(page.getByTestId("invoice-preview-empty")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("invoice-preview-skipped-invoiced")).toBeVisible();
  await expect(page.getByTestId("invoice-create")).toBeDisabled();
  await page.getByTestId("invoice-cancel").click();

  // Deleting the draft gives the time back.
  await page.locator('[data-testid^="invoice-row-"]').first().click();
  await expect(page.getByTestId("invoice-detail")).toBeVisible();
  await page.getByTestId("invoice-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.locator('[data-testid^="invoice-row-"]')).toHaveCount(0, { timeout: 20_000 });
  await openPreview(page, CLIENT);
  await expect(page.getByTestId("invoice-preview-line")).toHaveCount(1, { timeout: 20_000 });
  await confirmCreate(page);
  await expect(page.getByTestId("invoice-detail-status")).toHaveText("draft", { timeout: 20_000 });

  // A status change is a signed edit too, and survives a reload.
  await page.getByTestId("invoice-status-set-sent").click();
  await expect(page.getByTestId("invoice-detail-status")).toHaveText("sent", { timeout: 20_000 });
  await page.reload();
  await expect(page.locator('[data-testid^="invoice-total-"]')).toHaveCount(1, { timeout: 20_000 });

  // Neither the client, the work nor the invoice reached the database in plaintext.
  const db = await getDb();
  for (const { name } of await db.listCollections().toArray()) {
    const rows = JSON.stringify(await db.collection(name).find({}).toArray());
    expect(rows.includes(CLIENT), `client name in ${name}`).toBe(false);
    expect(rows.includes(WORK), `entry description in ${name}`).toBe(false);
    expect(rows.includes(PROJECT), `project name in ${name}`).toBe(false);
  }
});
