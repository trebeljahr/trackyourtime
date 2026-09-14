import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { logManualEntry, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";

const PROJECT_NAME = "PDF export rig";
const ENTRY_DESCRIPTION = "Something worth printing";
const ENTRY_DURATION = "1:00:00";

let sequence = 0;

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** Local "YYYY-MM-DD", `offsetDays` away from today. */
function dayKey(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Pinning the range in the query string keeps the export independent of
 * today's weekday and of the workspace's week-start preference.
 */
const RANGE_QUERY = `?from=${dayKey(-7)}&to=${dayKey(1)}`;

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("PDF export", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "PDF User",
      email: uniqueEmail("pdf"),
      password: PASSWORD,
    });

    await page.goto("/track");
    await expect(page.getByTestId("track-page")).toBeVisible();
    await expect(page.getByTestId("entries-empty")).toBeVisible();

    await page.getByTestId("tracker-project").click();
    await page.getByTestId("combobox-search").fill(PROJECT_NAME);
    await page.getByTestId("combobox-create").click();
    await expect(page.getByTestId("tracker-project")).toContainText(
      PROJECT_NAME,
    );

    await logManualEntry(page, ENTRY_DESCRIPTION, ENTRY_DURATION);
  });

  test("downloads a real PDF of the totals report", async ({ page }) => {
    await page.goto(`/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("summary-report")).toBeVisible();
    // The button stays disabled until the report has answered; clicking before
    // that would open nothing.
    await expect(page.getByTestId("report-export")).toBeEnabled();

    await page.getByTestId("report-export").click();
    await expect(page.getByTestId("report-export-menu")).toBeVisible();

    // The download is started from a blob url built in the page, so the event
    // has to be awaited alongside the click rather than after it.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByTestId("report-export-pdf").click(),
    ]);

    // Same naming rule as the CSV export (`csvFilename` in services/csv.ts):
    // "trackyourtime-<report>-<from>_<to>", only with a .pdf suffix. Asserted with
    // the range in it, so a filename that silently lost the dates still fails.
    expect(download.suggestedFilename()).toMatch(
      /^trackyourtime-summary-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/,
    );

    const path = await download.path();
    expect(path).not.toBeNull();
    const bytes = await readFile(path as string);

    // A PDF is only a PDF if it starts with the header — a JSON error page or a
    // base64 string that never got decoded would both fail here.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Non-trivial size: an empty or truncated render would be a few hundred bytes.
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    // pdfkit closes the file with the EOF marker; its presence means the whole
    // document reached the browser, not just the first chunk.
    expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
  });

  test("export follows the active view", async ({ page }) => {
    // The Entries view shares the export button with Totals, so the button
    // must ask for the report on screen, not the one the page opened on.
    await page.goto(`/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("summary-report")).toBeVisible();
    await page.getByTestId("report-view-entries").click();
    await expect(page.getByTestId("detailed-report")).toBeVisible();
    await expect(page.getByTestId("report-export")).toBeEnabled();

    await page.getByTestId("report-export").click();
    await expect(page.getByTestId("report-export-menu")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByTestId("report-export-pdf").click(),
    ]);

    expect(download.suggestedFilename()).toMatch(
      /^trackyourtime-detailed-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/,
    );
    const path = await download.path();
    expect(path).not.toBeNull();
    const bytes = await readFile(path as string);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("the print item is gone — the PDF is server-rendered now", async ({
    page,
  }) => {
    await page.goto(`/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("summary-report")).toBeVisible();

    await page.getByTestId("report-export").click();
    await expect(page.getByTestId("report-export-menu")).toBeVisible();
    await expect(page.getByTestId("report-export-csv")).toBeVisible();
    await expect(page.getByTestId("report-export-pdf")).toBeVisible();
    await expect(page.getByTestId("report-export-print")).toHaveCount(0);
  });
});
