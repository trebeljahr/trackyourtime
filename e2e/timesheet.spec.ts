import { test, expect, type Locator, type Page } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";
const PROJECT_NAME = "Timesheet project";

let sequence = 0;

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** Pick an option out of an open-on-click combobox by its visible label. */
async function pickComboboxOption(
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

/** The grid row for a project, whatever id the server gave it. */
function rowFor(page: Page, label: string): Locator {
  return page
    .locator('[data-testid^="timesheet-row-"]')
    .filter({ hasText: label });
}

/** The seven day cells of a row, in column order. */
function cellsOf(row: Locator): Locator {
  return row.locator('[data-testid^="timesheet-cell-"]');
}

/**
 * Create the project from the grid's own picker.
 *
 * Adding a row is supposed to work without a detour to the Projects screen,
 * so the test takes the same route a user would.
 */
async function createProjectFromPicker(
  page: Page,
  triggerTestId: string,
  name: string,
): Promise<void> {
  await page.getByTestId(triggerTestId).click();
  await page.getByTestId("combobox-search").fill(name);
  await page.getByTestId("combobox-create").click();
  await expect(page.getByTestId(triggerTestId)).toContainText(name);
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Weekly timesheet", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Timesheet User",
      email: uniqueEmail("timesheet"),
      password: PASSWORD,
    });

    await page.goto("/app/timesheet");
    await expect(page.getByTestId("timesheet-page")).toBeVisible();
    await expect(page.getByTestId("timesheet-empty")).toBeVisible();

    // A row is added once here; every test below fills it in.
    await createProjectFromPicker(page, "timesheet-row-project", PROJECT_NAME);
    await page.getByTestId("timesheet-add-row-submit").click();
    await expect(rowFor(page, PROJECT_NAME)).toHaveCount(1);
  });

  test("types hours into an empty cell and edits them again", async ({
    page,
  }) => {
    const cells = cellsOf(rowFor(page, PROJECT_NAME));
    const monday = cells.nth(0);

    // ── an empty cell creates one entry ─────────────────────────────
    await expect(monday).toHaveValue("");
    await monday.fill("2");
    await monday.press("Enter");

    await expect(monday).toHaveValue("2:00:00");
    await expect(
      page.getByTestId("timesheet-day-total-0"),
    ).toHaveText("2:00:00");
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "2:00:00",
    );

    // ── the same cell now holds one entry, and adjusts it ───────────
    await monday.fill("3:30");
    await monday.press("Enter");

    await expect(monday).toHaveValue("3:30:00");
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "3:30:00",
    );

    // A bare number is hours and "90m" is ninety minutes — same field.
    await monday.fill("90m");
    await monday.press("Enter");
    await expect(monday).toHaveValue("1:30:00");

    // ── the entry is real, and lands on the day it was typed into ───
    await page.goto("/app/track");
    await expect(page.getByTestId("track-page")).toBeVisible();
    await expect(page.locator('[data-testid="entry-row"]')).toHaveCount(1);
  });

  test("reverts a cell on Escape and refuses nonsense", async ({ page }) => {
    const cells = cellsOf(rowFor(page, PROJECT_NAME));
    const tuesday = cells.nth(1);

    await tuesday.fill("4");
    await tuesday.press("Escape");
    await expect(tuesday).toHaveValue("");

    await tuesday.fill("lunchtime");
    await tuesday.press("Enter");
    await expect(tuesday).toHaveValue("");
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "0:00:00",
    );
  });

  test("moves between cells with the keyboard", async ({ page }) => {
    const cells = cellsOf(rowFor(page, PROJECT_NAME));

    await cells.nth(0).focus();
    await expect(cells.nth(0)).toBeFocused();

    await cells.nth(0).press("ArrowRight");
    await expect(cells.nth(1)).toBeFocused();

    await cells.nth(1).press("Tab");
    await expect(cells.nth(2)).toBeFocused();

    await cells.nth(2).press("End");
    await expect(cells.nth(6)).toBeFocused();

    await cells.nth(6).press("Home");
    await expect(cells.nth(0)).toBeFocused();

    // Arrows commit on the way out, so typing then moving keeps the value.
    await cells.nth(0).fill("1");
    await cells.nth(0).press("ArrowRight");
    await expect(cells.nth(1)).toBeFocused();
    await expect(cells.nth(0)).toHaveValue("1:00:00");
  });

  test("navigates weeks and comes back to this one", async ({ page }) => {
    const cells = cellsOf(rowFor(page, PROJECT_NAME));
    await cells.nth(0).fill("2");
    await cells.nth(0).press("Enter");
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "2:00:00",
    );

    // Last week: the pinned row is still there, its hours are not.
    await page.getByTestId("timesheet-week-prev").click();
    await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "0:00:00",
    );
    await expect(cellsOf(rowFor(page, PROJECT_NAME)).nth(0)).toHaveValue("");

    await page.getByTestId("timesheet-week-next").click();
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "2:00:00",
    );

    // Two weeks out and straight back to today.
    await page.getByTestId("timesheet-week-next").click();
    await page.getByTestId("timesheet-week-current").click();
    await expect(page.getByTestId("timesheet-week-current")).toHaveText(
      "This week",
    );
    await expect(page.getByTestId("timesheet-week-total")).toHaveText(
      "2:00:00",
    );
  });

  test("will not let the running timer's cell be overwritten", async ({
    page,
  }) => {
    await page.goto("/app/track");
    await expect(page.getByTestId("track-page")).toBeVisible();
    await pickComboboxOption(page, "tracker-project", PROJECT_NAME);
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("running-timer-indicator")).toBeVisible();

    await page.goto("/app/timesheet");
    const row = rowFor(page, PROJECT_NAME);

    // The cell holding the timer is a button, not a field — there is nothing
    // to type into, so a grid edit cannot clobber the entry the timer owns.
    await expect(row.locator('button[data-cell-state="running"]')).toHaveCount(
      1,
    );
    await expect(row.locator('input[data-cell-state="running"]')).toHaveCount(
      0,
    );
  });
});
