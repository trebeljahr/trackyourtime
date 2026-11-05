import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";

import { pageTexts } from "../packages/server/src/tests/support/pdf-text";

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
    // The web renderer uses the standard-14 Helvetica (not embedded), so a
    // one-line invoice is ~2 KB — real, but not the tens of KB an embedded
    // font would add.
    expect(bytes.byteLength).toBeGreaterThan(1500);
  });

  test("prints the service period, wraps a long line and shows no draft status", async ({ page }) => {
    await page.goto("/invoice-generator/");
    await page.getByTestId("issuer-legalName").fill("Acme GmbH");
    await page.getByTestId("recipient-name").fill("Client Co");
    await page.getByTestId("invoice-number").fill("E2E-002");
    await page.getByTestId("invoice-issueDate").fill("2026-11-06");
    await page.getByTestId("invoice-periodStart").fill("2026-10-01");
    await page.getByTestId("invoice-periodEnd").fill("2026-10-31");

    const label =
      "Implementation of the customer onboarding flow including account creation, " +
      "email verification and a written hand-over for the support team";
    await page.getByTestId("generator-line-0-label").fill(label);
    await page.getByTestId("generator-line-0-unit-price").fill("120");
    await expect(page.getByTestId("generator-line-count")).toContainText("1 line ready");

    const [downloaded] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByTestId("generator-download").click(),
    ]);
    const text = pageTexts(await readFile(await downloaded.path())).join("");

    // A one-off invoice has no workflow: no "Status: Draft", no "Grouped by".
    for (const absent of ["Status", "Draft", "Grouped by", "..."]) {
      expect(text, `${absent} printed`).not.toContain(absent);
    }
    expect(text).toContain("Period2026-10-01 to 2026-10-31");
    // Every word of the long description is drawn, in order, wrapped.
    let from = 0;
    for (const word of label.split(" ")) {
      const at = text.indexOf(word, from);
      expect(at, `missing ${word}`).toBeGreaterThanOrEqual(0);
      from = at + word.length;
    }

    // The dates survive a reload as part of the draft.
    await page.reload();
    await expect(page.getByTestId("invoice-periodStart")).toHaveValue("2026-10-01");
    await expect(page.getByTestId("invoice-periodEnd")).toHaveValue("2026-10-31");
  });

  test("adds and removes a line", async ({ page }) => {
    await page.goto("/invoice-generator/");
    await page.getByTestId("generator-add-line").click();
    await expect(page.getByTestId("generator-line-1")).toBeVisible();
    await page.getByTestId("generator-line-1-remove").click();
    await expect(page.getByTestId("generator-line-1")).toHaveCount(0);
  });
});
