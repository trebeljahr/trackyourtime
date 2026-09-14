import { test, expect } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";
import {
  CLIENT_NAME,
  PROJECT_NAME,
  confirmCreate,
  createClientAndProject,
  money,
  openPreview,
  trackBillableHours,
} from "./invoice-helpers";

const PASSWORD = "SecurePassword123!";

let sequence = 0;

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Invoicing", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Invoice User",
      email: uniqueEmail("invoices"),
      password: PASSWORD,
    });
    await createClientAndProject(page);
  });

  test("bills tracked time once, and never a second time", async ({ page }) => {
    await trackBillableHours(page, "Foundations", "3:00:00");

    // ── preview: three hours at 100 ─────────────────────────────────
    await openPreview(page);

    const previewLines = page.getByTestId("invoice-preview-line");
    await expect(previewLines).toHaveCount(1);
    await expect(previewLines.first()).toContainText(PROJECT_NAME);
    await expect(previewLines.first()).toContainText("3.00 h");
    await expect(previewLines.first()).toContainText(money(300));
    await expect(page.getByTestId("invoice-preview-subtotal")).toContainText(
      money(300),
    );
    await expect(page.getByTestId("invoice-preview-total")).toContainText(
      money(300),
    );
    // Nothing has been billed yet, so nothing is excluded.
    await expect(page.getByTestId("invoice-preview-skipped-invoiced")).toHaveCount(
      0,
    );

    await confirmCreate(page);

    // ── the document ────────────────────────────────────────────────
    const detail = page.getByTestId("invoice-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("invoice-detail-client")).toContainText(
      CLIENT_NAME,
    );
    await expect(page.getByTestId("invoice-detail-status")).toHaveText("draft");
    await expect(page.getByTestId("invoice-detail-line")).toHaveCount(1);
    await expect(page.getByTestId("invoice-detail-line").first()).toContainText(
      "3.00 h",
    );
    await expect(page.getByTestId("invoice-detail-total")).toContainText(
      money(300),
    );
    await expect(page.getByTestId("invoices-count")).toHaveText("1 invoice");

    // ── THE POINT: the same range cannot be billed again ────────────
    //
    // Every hour in the range is now on an invoice, so a second attempt over
    // exactly the same dates must find nothing to bill — and must say WHY,
    // rather than looking broken or, far worse, quietly billing 300 twice.
    await openPreview(page);
    await expect(page.getByTestId("invoice-preview-empty")).toBeVisible();
    await expect(page.getByTestId("invoice-preview-empty")).toContainText(
      "already been invoiced",
    );
    await expect(
      page.getByTestId("invoice-preview-skipped-invoiced"),
    ).toBeVisible();
    await expect(page.getByTestId("invoice-preview-line")).toHaveCount(0);
    // The irreversible button is not merely hidden behind a confirmation —
    // there is nothing it could legally do, so it is disabled outright.
    await expect(page.getByTestId("invoice-create")).toBeDisabled();
    await page.getByTestId("invoice-cancel").click();
    await expect(page.getByTestId("invoice-dialog")).toBeHidden();

    // ── new time in the same range bills, the old time still does not ──
    await trackBillableHours(page, "Follow-up", "1:00:00");
    await openPreview(page);

    await expect(page.getByTestId("invoice-preview-line")).toHaveCount(1);
    await expect(page.getByTestId("invoice-preview-line").first()).toContainText(
      "1.00 h",
    );
    // 100, not 400: the three invoiced hours are still excluded.
    await expect(page.getByTestId("invoice-preview-total")).toContainText(
      money(100),
    );
    await expect(
      page.getByTestId("invoice-preview-skipped-invoiced"),
    ).toBeVisible();

    await confirmCreate(page);

    await expect(page.getByTestId("invoices-count")).toHaveText("2 invoices");
    const totals = page.locator('[data-testid^="invoice-total-"]');
    await expect(totals).toHaveCount(2);
    // Four tracked hours have been billed as 300 + 100. Any double billing
    // would show up here as a 400 or a second 300.
    await expect(totals.filter({ hasText: money(300) })).toHaveCount(1);
    await expect(totals.filter({ hasText: money(100) })).toHaveCount(1);
    await expect(totals.filter({ hasText: money(400) })).toHaveCount(0);
  });

  test("deleting a draft makes its time billable again", async ({ page }) => {
    await trackBillableHours(page, "Foundations", "3:00:00");
    await openPreview(page);
    await confirmCreate(page);

    await expect(page.getByTestId("invoice-detail-total")).toContainText(
      money(300),
    );

    await page.getByTestId("invoice-delete").click();
    await expect(page.getByTestId("invoice-delete-dialog")).toBeVisible();
    await page.getByTestId("confirm-accept").click();

    await expect(page.getByTestId("invoice-detail")).toHaveCount(0);
    await expect(page.getByTestId("invoices-empty")).toBeVisible();

    // The counterpart of the double-billing guard: releasing the invoice must
    // release the time with it, or those hours would be billable nowhere.
    await openPreview(page);
    await expect(page.getByTestId("invoice-preview-line")).toHaveCount(1);
    await expect(page.getByTestId("invoice-preview-total")).toContainText(
      money(300),
    );
    await expect(page.getByTestId("invoice-preview-skipped-invoiced")).toHaveCount(
      0,
    );
  });

  test("walks draft → sent → paid and closes the door behind it", async ({
    page,
  }) => {
    await trackBillableHours(page, "Foundations", "3:00:00");
    await openPreview(page);
    await confirmCreate(page);

    // A draft is the only state that can be deleted, and the only forward
    // step offered is "sent" — never straight to paid.
    await expect(page.getByTestId("invoice-delete")).toBeVisible();
    await expect(page.getByTestId("invoice-status-set-paid")).toHaveCount(0);

    await page.getByTestId("invoice-status-set-sent").click();
    await expect(page.getByTestId("invoice-detail-status")).toHaveText("sent");
    // Sent has left the building: it is a record now, not a deletable draft.
    await expect(page.getByTestId("invoice-delete")).toHaveCount(0);
    await expect(page.getByTestId("invoice-status-set-draft")).toBeVisible();

    await page.getByTestId("invoice-status-set-paid").click();
    await expect(page.getByTestId("invoice-detail-status")).toHaveText("paid");
    // A paid invoice walks back one step at a time — never straight to draft.
    await expect(page.getByTestId("invoice-status-set-draft")).toHaveCount(0);
    await expect(page.getByTestId("invoice-status-set-sent")).toBeVisible();
  });
});
