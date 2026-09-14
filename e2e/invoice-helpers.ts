import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import { logManualEntry } from "./helpers";

/*
 * Helpers shared by e2e/invoices.spec.ts and e2e/einvoice.spec.ts: the
 * billable setup, the create flow, seeding the business profile and a
 * client's billing details through their real forms, and reading downloads.
 */

export const CLIENT_NAME = "Northwind";
export const PROJECT_NAME = "Billable build";
/** A round rate, so every amount is a round number. */
export const PROJECT_RATE = "100";

/** Local "YYYY-MM-DD", `offsetDays` away from today. */
export function dayKey(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The billed range every invoice uses: a week back to tomorrow, so nothing
 * depends on today's weekday or on the month boundary.
 */
export const RANGE_FROM = dayKey(-7);
export const RANGE_TO = dayKey(1);

/**
 * Money is rendered through `Intl.NumberFormat`, so the decimal separator
 * depends on the runner's locale. Match the digits, not the punctuation.
 */
export const money = (whole: number): RegExp => new RegExp(`${whole}[.,]00`);

/**
 * Read the entity id out of a row's `data-testid`.
 *
 * Rows appear first as an optimistic placeholder whose id is a client-side
 * "optimistic-<uuid>", then get replaced when the server responds with the
 * real document. Reading the placeholder id yields locators that stop matching
 * a moment later, so wait for the real id before returning it.
 */
export async function idFromTestId(row: Locator, prefix: string): Promise<string> {
  await expect
    .poll(async () => (await row.getAttribute("data-testid"))?.slice(prefix.length), {
      message: `expected a settled ${prefix}<id> test id`,
    })
    .not.toMatch(/^optimistic-/);
  const testId = await row.getAttribute("data-testid");
  expect(testId, `expected a ${prefix}<id> test id`).not.toBeNull();
  return (testId ?? "").slice(prefix.length);
}

/** Pick an option out of an open-on-click combobox by its visible label. */
export async function pickComboboxOption(
  page: Page,
  triggerTestId: string,
  label: string,
): Promise<void> {
  await page.getByTestId(triggerTestId).click();
  await page.getByTestId("combobox-search").fill(label);
  await page
    .locator('[data-testid^="combobox-option-"]')
    .filter({ hasText: label })
    .first()
    .click();
}

/**
 * Create the client and the project that carries the rate.
 *
 * The rate matters more than anything else in this setup: it is SNAPSHOTTED
 * onto every entry as it stops, and an entry with no rate can never be
 * invoiced at all.
 */
export async function createClientAndProject(
  page: Page,
  clientName: string = CLIENT_NAME,
  projectName: string = PROJECT_NAME,
): Promise<void> {
  await page.goto("/projects");
  await expect(page.getByTestId("projects-page")).toBeVisible();

  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("project-dialog")).toBeVisible();
  await page.getByTestId("project-name-input").fill(projectName);

  // Coin the client from inside the project form — there is no separate
  // "new client" screen to detour through.
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

/**
 * Log one billable entry from the tracker bar.
 *
 * The duration field anchors the end to the pre-filled start, so the billed
 * seconds are exact rather than wall-clock — an invoice assertion cannot
 * afford a stopwatch's worth of slop.
 */
export async function trackBillableHours(
  page: Page,
  description: string,
  duration: string,
  projectName: string = PROJECT_NAME,
): Promise<void> {
  await page.goto("/track");
  await expect(page.getByTestId("track-page")).toBeVisible();
  await pickComboboxOption(page, "tracker-project", projectName);
  await expect(page.getByTestId("tracker-billable")).toHaveAttribute("data-billable", "true");
  await logManualEntry(page, description, duration);
}

/** Open the create dialog and fill in client + range, stopping at the preview. */
export async function openPreview(page: Page, clientName: string = CLIENT_NAME): Promise<void> {
  await page.goto("/invoices");
  await expect(page.getByTestId("invoices-page")).toBeVisible();
  await page.getByTestId("new-invoice").click();
  await expect(page.getByTestId("invoice-dialog")).toBeVisible();

  await pickComboboxOption(page, "invoice-client-combobox", clientName);

  await page.getByTestId("invoice-range").click();
  await expect(page.getByTestId("invoice-range-content")).toBeVisible();
  await page.getByTestId("invoice-range-from").fill(RANGE_FROM);
  await page.getByTestId("invoice-range-to").fill(RANGE_TO);
  // Escape dismisses the topmost layer — the range popover — and must leave
  // the dialog under it standing.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("invoice-range-content")).toBeHidden();
  await expect(page.getByTestId("invoice-dialog")).toBeVisible();
}

/**
 * Commit the previewed invoice.
 *
 * Creating is deliberately two clicks: the first opens a confirmation strip
 * that restates the money, the second writes. Previewing must never be able
 * to bill anything by accident.
 */
export async function confirmCreate(page: Page): Promise<void> {
  await page.getByTestId("invoice-create").click();
  await expect(page.getByTestId("invoice-create-confirm-panel")).toBeVisible();
  await page.getByTestId("invoice-create-confirm").click();
  await expect(page.getByTestId("invoice-dialog")).toBeHidden();
}

// ── billing data ──────────────────────────────────────────────────────

/** Text inputs of Settings → Billing → Business profile, by model key. */
export type ProfileField =
  | "legalName"
  | "address-0"
  | "postalCode"
  | "city"
  | "country"
  | "email"
  | "phone"
  | "vatId"
  | "contactName"
  | "iban"
  | "bic"
  | "accountHolder"
  | "terms";

export const DEFAULT_PROFILE: Record<ProfileField, string> = {
  legalName: "Example Consulting GmbH",
  "address-0": "Musterstraße 1",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  email: "billing@example.com",
  phone: "+49 30 123456",
  vatId: "DE123456789",
  contactName: "Erika Mustermann",
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  accountHolder: "Example Consulting GmbH",
  terms: "14",
};

/**
 * Fill the business profile through its form and Save once. A value of ""
 * leaves that field empty. The default VAT is 19 %. Reloads afterwards, so
 * what the caller sees next is what was stored.
 */
export async function fillBusinessProfile(
  page: Page,
  overrides: Partial<Record<ProfileField, string>> = {},
): Promise<void> {
  await page.goto("/settings?tab=billing");
  await expect(page.getByTestId("business-profile-form")).toBeVisible();

  const values = { ...DEFAULT_PROFILE, ...overrides };
  for (const [field, value] of Object.entries(values)) {
    await page.getByTestId(`business-profile-${field}`).fill(value);
  }
  await page.getByTestId("business-profile-defaultTaxCategory").selectOption("S19");

  const saved = page.waitForResponse(
    (response) => response.url().includes("settings.updateBusinessProfile") && response.ok(),
  );
  await page.getByTestId("business-profile-save").click();
  await saved;

  await page.reload();
  await expect(page.getByTestId("business-profile-legalName")).toHaveValue(values.legalName);
  await expect(page.getByTestId("business-profile-vatId")).toHaveValue(values.vatId);
  await expect(page.getByTestId("business-profile-defaultTaxCategory")).toHaveValue("S19");
}

/** Billing inputs of the client dialog, by model key. */
export type ClientBillingField =
  | "legalName"
  | "address-0"
  | "postalCode"
  | "city"
  | "country"
  | "reference"
  | "electronicAddress";

export const DEFAULT_CLIENT_BILLING: Record<ClientBillingField, string> = {
  legalName: "Northwind Handels GmbH",
  "address-0": "Hauptstraße 5",
  postalCode: "80331",
  city: "München",
  country: "DE",
  reference: "991-12345-06",
  electronicAddress: "invoices@northwind.example",
};

/** The client's id, read off its row on /clients. */
export async function clientIdByName(page: Page, clientName: string): Promise<string> {
  await page.goto("/clients");
  await expect(page.getByTestId("clients-table")).toBeVisible();
  const row = page.locator('[data-testid^="client-row-"]').filter({ hasText: clientName });
  await expect(row).toHaveCount(1);
  return idFromTestId(row, "client-row-");
}

/**
 * Clients → row menu → Edit → Billing details, fill, Save. A value of ""
 * leaves that field empty. Preferred format XRechnung.
 */
export async function fillClientBilling(
  page: Page,
  clientName: string = CLIENT_NAME,
  overrides: Partial<Record<ClientBillingField, string>> = {},
): Promise<string> {
  const clientId = await clientIdByName(page, clientName);
  await page.getByTestId(`client-menu-${clientId}`).click();
  await page.getByTestId(`client-edit-${clientId}`).click();
  const dialog = page.getByTestId("client-dialog");
  await expect(dialog).toBeVisible();

  const toggle = page.getByTestId("client-billing-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();

  const values = { ...DEFAULT_CLIENT_BILLING, ...overrides };
  for (const [field, value] of Object.entries(values)) {
    await page.getByTestId(`client-billing-${field}`).fill(value);
  }
  await page.getByTestId("client-billing-preferredFormat").selectOption("xrechnung");

  const saved = page.waitForResponse(
    (response) => response.url().includes("clients.update") && response.ok(),
  );
  await page.getByTestId("client-submit").click();
  await saved;
  await expect(dialog).toBeHidden();
  return clientId;
}

// ── downloads ─────────────────────────────────────────────────────────

/** Click a download button and read the file the browser received. */
export async function downloadBytes(
  page: Page,
  testId: string,
): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByTestId(testId).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  return { name: download.suggestedFilename(), bytes: await readFile(path as string) };
}

/**
 * The payload of every `/Type /EmbeddedFile` stream in a PDF, inflated when
 * it is Flate-compressed. A byte scan, not a PDF parser: enough for the files
 * pdfkit writes, where each stream follows its dictionary on the same object.
 */
export function embeddedFilePayloads(pdf: Buffer): Buffer[] {
  const text = pdf.toString("latin1");
  const payloads: Buffer[] = [];
  let from = 0;
  for (;;) {
    const marker = text.indexOf("/Type /EmbeddedFile", from);
    if (marker === -1) break;
    const objStart = text.lastIndexOf(" obj", marker);
    const streamKeyword = text.indexOf("stream", marker);
    const dict = text.slice(objStart, streamKeyword);
    let dataStart = streamKeyword + "stream".length;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;
    const dataEnd = text.indexOf("endstream", dataStart);
    let raw = pdf.subarray(dataStart, dataEnd);
    if (raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
    if (raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
    payloads.push(dict.includes("/FlateDecode") ? inflateSync(raw) : raw);
    from = dataEnd;
  }
  return payloads;
}
