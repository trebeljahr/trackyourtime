import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";

/**
 * The public invoice generator (`/invoice-generator/`) makes a PDF in the
 * browser — no account and no server call. It is a static marketing page, so
 * this spec needs no sign-in; it is served from the same static export the
 * rest of the suite builds (playwright.config.ts). The API webServer still has
 * to be up for the suite to start, but nothing here touches it.
 */
test.describe("invoice generator", () => {
  test("builds a downloadable PDF from a filled line", async ({ page }) => {
    await page.goto("/invoice-generator/");
    await expect(page.getByTestId("marketing-title")).toContainText("Make an invoice");

    await page.getByTestId("issuer-legalName").fill("Acme GmbH");
    await page.getByTestId("recipient-name").fill("Client Co");
    await page.getByTestId("invoice-number").fill("E2E-001");

    // One complete line is enough to bill: the row defaults to quantity 1,
    // standard rate 19 %, so a label and a unit price finish it.
    await page.getByTestId("generator-line-0-label").fill("Design review");
    await page.getByTestId("generator-line-0-unit-price").fill("120");
    await expect(page.getByTestId("generator-line-count")).toContainText("1 line ready");

    const download = page.getByTestId("generator-download");
    await expect(download).toBeEnabled();

    const [downloaded] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      download.click(),
    ]);
    expect(downloaded.suggestedFilename()).toBe("invoice-E2E-001.pdf");

    const path = await downloaded.path();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(3000);
  });

  test("adds and removes a line", async ({ page }) => {
    await page.goto("/invoice-generator/");
    await page.getByTestId("generator-add-line").click();
    await expect(page.getByTestId("generator-line-1")).toBeVisible();
    await page.getByTestId("generator-line-1-remove").click();
    await expect(page.getByTestId("generator-line-1")).toHaveCount(0);
  });
});
