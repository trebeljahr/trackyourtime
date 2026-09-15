import { test, expect, type Locator } from "@playwright/test";
import { logManualEntry, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";

const PROJECT_NAME = "Reporting rig";

/** Two manual blocks of exactly one hour and exactly thirty minutes. */
const FIRST_DURATION = "1:00:00";
const SECOND_DURATION = "0:30:00";
const TOTAL_DURATION = "1:30:00";

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
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

/**
 * Report filters live in the query string, so pinning the range there keeps
 * the assertions independent of today's weekday and of the workspace's
 * week-start preference.
 */
const RANGE_QUERY = `?from=${dayKey(-7)}&to=${dayKey(1)}`;

/**
 * Read the opaque id out of a `<prefix><id>` test id, once it has settled —
 * an optimistic row carries a placeholder id that a later assertion would
 * chase.
 */
async function idFromTestId(row: Locator, prefix: string): Promise<string> {
  await expect
    .poll(
      async () => (await row.getAttribute("data-testid"))?.slice(prefix.length),
      { message: `expected a settled ${prefix}<id> test id` }
    )
    .not.toMatch(/^optimistic-/);

  const testId = await row.getAttribute("data-testid");
  expect(testId, `expected a ${prefix}<id> test id`).not.toBeNull();
  return (testId ?? "").slice(prefix.length);
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Reports", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Reports User",
      email: uniqueEmail("reports"),
      password: PASSWORD,
    });

    await page.goto("/app/track");
    await expect(page.getByTestId("track-page")).toBeVisible();
    await expect(page.getByTestId("entries-empty")).toBeVisible();

    // Create the project straight from the tracker's picker, then track
    // against it.
    await page.getByTestId("tracker-project").click();
    await page.getByTestId("combobox-search").fill(PROJECT_NAME);
    await page.getByTestId("combobox-create").click();
    await expect(page.getByTestId("tracker-project")).toContainText(
      PROJECT_NAME
    );

    await logManualEntry(page, "Report groundwork", FIRST_DURATION);
    await logManualEntry(page, "Report polish", SECOND_DURATION);

    // Nothing may be running: a live entry would make the report totals move
    // between assertions.
    await expect(
      page.locator('[data-testid="entry-row"][data-running="true"]')
    ).toHaveCount(0);
  });

  test("totals add up the tracked time and groups it", async ({ page }) => {
    await page.goto(`/app/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("summary-report")).toBeVisible();

    // Headline figures match the two entries exactly.
    await expect(page.getByTestId("kpi-total")).toHaveText(TOTAL_DURATION);
    await expect(page.getByTestId("kpi-non-billable")).toBeVisible();

    // Default grouping is by project.
    await expect(page.getByTestId("groupby-project")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const summaryRows = page.locator('[data-testid^="summary-row-"]');
    await expect(summaryRows).toHaveCount(1);
    await expect(summaryRows.first()).toContainText(PROJECT_NAME);
    await expect(summaryRows.first()).toContainText(TOTAL_DURATION);

    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );
    await expect(page.getByTestId("summary-empty")).toHaveCount(0);

    // Switching the dimension re-groups the same time without losing any.
    await page.getByTestId("groupby-client").click();
    await expect(page.getByTestId("groupby-client")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page).toHaveURL(/group=client/);
    await expect(summaryRows).toHaveCount(1);
    // The project has no client, so everything rolls up under the fallback.
    await expect(summaryRows.first()).toContainText("No client");
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );

    // …and switching back lists the project again.
    await page.getByTestId("groupby-project").click();
    await expect(summaryRows.first()).toContainText(PROJECT_NAME);
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );
  });

  test("creates and renames a client from the filter bar", async ({ page }) => {
    await page.goto(`/app/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("report-filters")).toBeVisible();

    // ── create one, without leaving the report ──────────────────────
    await page.getByTestId("filter-clients").click();
    await page.getByTestId("filter-clients-new").click();

    const dialog = page.getByTestId("client-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("client-name-input").fill("Filter Bar Co");
    await page.getByTestId("client-submit").click();
    await expect(dialog).toBeHidden();

    // It lands in the very list it was created from.
    await page.getByTestId("filter-clients").click();
    const option = page
      .locator('[data-testid^="filter-clients-option-"]')
      .filter({ hasText: "Filter Bar Co" });
    await expect(option).toHaveCount(1);
    const clientId = await idFromTestId(option, "filter-clients-option-");

    // ── and the pencil edits it, rather than ticking the filter ─────
    await page.getByTestId(`filter-clients-edit-${clientId}`).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("client-name-input")).toHaveValue(
      "Filter Bar Co"
    );
    await page.getByTestId("client-name-input").fill("Filter Bar Ltd");
    await page.getByTestId("client-submit").click();
    await expect(dialog).toBeHidden();

    // The pencil is not a selection: no client filter reached the URL.
    await expect(page).not.toHaveURL(/clients=/);
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );

    await page.getByTestId("filter-clients").click();
    await expect(
      page.getByTestId(`filter-clients-option-${clientId}`)
    ).toContainText("Filter Bar Ltd");
  });

  test("entries list every entry in the range", async ({ page }) => {
    await page.goto(`/app/reports${RANGE_QUERY}&view=entries`);
    await expect(page.getByTestId("detailed-report")).toBeVisible();
    await expect(page.getByTestId("detailed-table")).toBeVisible();

    const rows = page.locator('[data-testid^="detailed-row-"]');
    await expect(rows).toHaveCount(2);

    await expect(page.getByTestId("kpi-entries")).toHaveText("2");
    await expect(page.getByTestId("kpi-total")).toHaveText(TOTAL_DURATION);
    await expect(page.getByTestId("detailed-empty")).toHaveCount(0);
    await expect(page.getByTestId("detailed-load-more")).toHaveCount(0);

    await expect(page.getByTestId("detailed-table")).toContainText(
      "Report groundwork"
    );
    await expect(page.getByTestId("detailed-table")).toContainText(
      "Report polish"
    );
    await expect(page.getByTestId("detailed-table")).toContainText(
      PROJECT_NAME
    );

    // Narrowing to a range with no tracked time empties the log rather than
    // showing stale rows.
    await page.goto(
      `/app/reports?from=${dayKey(-30)}&to=${dayKey(-20)}&view=entries`
    );
    await expect(page.getByTestId("detailed-empty")).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId("kpi-total")).toHaveText("0:00:00");
  });

  test("switching views keeps the filters", async ({ page }) => {
    await page.goto(`/app/reports${RANGE_QUERY}&group=client`);
    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("report-view-totals")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Narrow to the project, from the one filter bar both views share.
    await page.getByTestId("filter-projects").click();
    const option = page
      .locator('[data-testid^="filter-projects-option-"]')
      .filter({ hasText: PROJECT_NAME });
    await expect(option).toHaveCount(1);
    const projectId = await idFromTestId(option, "filter-projects-option-");
    await option.click();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`projects=${projectId}`));
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );

    // ── Totals → Entries ────────────────────────────────────────────
    await page.getByTestId("report-view-entries").click();
    await expect(page.getByTestId("report-view-entries")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("report-view-totals")).toHaveAttribute(
      "aria-selected",
      "false"
    );
    await expect(page).toHaveURL(/view=entries/);
    await expect(page).toHaveURL(new RegExp(`from=${dayKey(-7)}`));
    await expect(page).toHaveURL(new RegExp(`to=${dayKey(1)}`));
    await expect(page).toHaveURL(new RegExp(`projects=${projectId}`));
    // Entries has no grouping, but the choice is kept for the way back.
    await expect(page).toHaveURL(/group=client/);

    await expect(page.getByTestId("detailed-report")).toBeVisible();
    await expect(page.getByTestId("summary-report")).toHaveCount(0);
    await expect(page.locator('[data-testid^="detailed-row-"]')).toHaveCount(2);
    await expect(page.getByTestId("filter-projects")).toContainText(
      PROJECT_NAME
    );

    // ── Entries → Totals ────────────────────────────────────────────
    await page.getByTestId("report-view-totals").click();
    await expect(page.getByTestId("report-view-totals")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page).not.toHaveURL(/view=/);
    await expect(page).toHaveURL(new RegExp(`from=${dayKey(-7)}`));
    await expect(page).toHaveURL(new RegExp(`projects=${projectId}`));
    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("detailed-report")).toHaveCount(0);
    await expect(page.getByTestId("groupby-client")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("filter-projects")).toContainText(
      PROJECT_NAME
    );
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      TOTAL_DURATION
    );
  });

  test("a grouped total drills down into its entries", async ({ page }) => {
    await page.goto(`/app/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("summary-report")).toBeVisible();

    const row = page.locator('[data-testid^="summary-row-"]');
    await expect(row).toHaveCount(1);
    const projectId = await idFromTestId(row, "summary-row-");

    await page.getByTestId(`summary-link-${projectId}`).click();

    await expect(page).toHaveURL(/view=entries/);
    await expect(page).toHaveURL(new RegExp(`projects=${projectId}`));
    await expect(page).toHaveURL(new RegExp(`from=${dayKey(-7)}`));
    await expect(page.getByTestId("report-view-entries")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("detailed-report")).toBeVisible();
    await expect(page.locator('[data-testid^="detailed-row-"]')).toHaveCount(2);
    await expect(page.getByTestId("filter-projects")).toContainText(
      PROJECT_NAME
    );
  });

  test("the sidebar has one Reports link", async ({ page }) => {
    await page.goto("/app/track");
    const nav = page.getByTestId("sidebar-nav");
    await expect(nav).toBeVisible();

    await expect(page.getByTestId("nav-reports")).toHaveCount(1);
    await expect(page.getByTestId("nav-reports")).toHaveAttribute(
      "href",
      /^\/app\/reports\/?$/
    );
    await expect(page.getByTestId("nav-summary")).toHaveCount(0);
    await expect(page.getByTestId("nav-detailed")).toHaveCount(0);
    await expect(page.getByTestId("nav-weekly")).toHaveCount(0);

    await page.getByTestId("nav-reports").click();
    await expect(page).toHaveURL(/\/app\/reports\/?(\?|$)/);
    await expect(page.getByTestId("report-view-switch")).toBeVisible();
    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("weekly-report")).toHaveCount(0);
  });
});

/**
 * The old report addresses are bookmarked and linked from outside the app, so
 * each one must land on the merged page with the equivalent view and filters.
 */
test.describe("Legacy report addresses", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Legacy Reports User",
      email: uniqueEmail("legacy-reports"),
      password: PASSWORD,
    });
  });

  /** Matches `/app/reports?…` and `/app/reports/?…`, never `/app/reports/summary`. */
  const MERGED_PAGE = /\/app\/reports\/?\?/;

  test("/app/reports/summary opens Totals with the same query", async ({
    page,
  }) => {
    await page.goto(`/app/reports/summary${RANGE_QUERY}&group=client`);

    await expect(page).toHaveURL(MERGED_PAGE);
    await expect(page).not.toHaveURL(/\/app\/reports\/summary/);
    await expect(page).not.toHaveURL(/view=/);
    await expect(page).toHaveURL(new RegExp(`from=${dayKey(-7)}`));
    await expect(page).toHaveURL(new RegExp(`to=${dayKey(1)}`));
    await expect(page).toHaveURL(/group=client/);

    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("report-view-totals")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("groupby-client")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  test("/app/reports/detailed opens Entries and drops the grouping", async ({
    page,
  }) => {
    await page.goto(
      `/app/reports/detailed${RANGE_QUERY}&group=tag&sort=duration&dir=desc`
    );

    await expect(page).toHaveURL(MERGED_PAGE);
    await expect(page).not.toHaveURL(/\/app\/reports\/detailed/);
    await expect(page).toHaveURL(/view=entries/);
    await expect(page).not.toHaveURL(/group=/);
    await expect(page).toHaveURL(new RegExp(`from=${dayKey(-7)}`));
    await expect(page).toHaveURL(new RegExp(`to=${dayKey(1)}`));
    await expect(page).toHaveURL(/sort=duration/);

    await expect(page.getByTestId("detailed-report")).toBeVisible();
    await expect(page.getByTestId("report-view-entries")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  test("/app/reports/weekly opens Totals for that week, by day", async ({
    page,
  }) => {
    const week = dayKey(-7);
    await page.goto(`/app/reports/weekly?week=${week}`);

    await expect(page).toHaveURL(MERGED_PAGE);
    await expect(page).not.toHaveURL(/\/app\/reports\/weekly/);
    await expect(page).not.toHaveURL(/view=/);
    await expect(page).not.toHaveURL(/week=/);
    await expect(page).toHaveURL(/group=day/);

    // The week start depends on the workspace setting, so assert the shape:
    // seven days, and the requested day inside them.
    const url = new URL(page.url());
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(6);
    expect((from ?? "") <= week && week <= (to ?? "")).toBe(true);

    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("groupby-day")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("weekly-report")).toHaveCount(0);
  });

  test("/app/reports/weekly with no week opens the current week", async ({
    page,
  }) => {
    await page.goto("/app/reports/weekly");

    await expect(page).toHaveURL(MERGED_PAGE);
    await expect(page).toHaveURL(/group=day/);

    const url = new URL(page.url());
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const today = dayKey(0);
    expect(from <= today && today <= to).toBe(true);
    await expect(page.getByTestId("summary-report")).toBeVisible();
  });
});
