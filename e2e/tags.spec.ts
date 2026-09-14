import { test, expect, type Locator, type Page } from "@playwright/test";
import { logManualEntry, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";

const DEEP_WORK = "deep work";
const ON_SITE = "on site";

/** One hour, so every duration assertion in here is a round number. */
const ONE_HOUR = "1:00:00";

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

/** Pins the report range so nothing here depends on today's weekday. */
const RANGE_QUERY = `?from=${dayKey(-7)}&to=${dayKey(1)}`;

/**
 * Read the entity id out of a row's `data-testid`.
 *
 * Rows appear first as an optimistic placeholder whose id is a client-side
 * "optimistic-<uuid>", then get replaced when the server responds with the
 * real document. Reading the placeholder id yields locators that stop matching
 * a moment later, so wait for the real id before returning it.
 */
async function idFromTestId(row: Locator, prefix: string): Promise<string> {
  await expect
    .poll(
      async () => (await row.getAttribute("data-testid"))?.slice(prefix.length),
      { message: `expected a settled ${prefix}<id> test id` },
    )
    .not.toMatch(/^optimistic-/);

  const testId = await row.getAttribute("data-testid");
  expect(testId, `expected a ${prefix}<id> test id`).not.toBeNull();
  return (testId ?? "").slice(prefix.length);
}

/**
 * Coin a tag from a tag picker without leaving the screen.
 *
 * The popover deliberately stays open after a pick, so it is closed explicitly
 * rather than by assuming the click dismissed it.
 */
async function createTagInline(
  page: Page,
  pickerTestId: string,
  name: string,
): Promise<void> {
  await page.getByTestId(pickerTestId).click();
  await expect(page.getByTestId(`${pickerTestId}-content`)).toBeVisible();
  await page.getByTestId(`${pickerTestId}-search`).fill(name);
  await page.getByTestId(`${pickerTestId}-create`).click();
  await expect(page.getByTestId(`${pickerTestId}-search`)).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`${pickerTestId}-content`)).toBeHidden();
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Tags", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Tag User",
      email: uniqueEmail("tags"),
      password: PASSWORD,
    });
  });

  test("coins a tag while tracking, then filters and groups a report by it", async ({
    page,
  }) => {
    await expect(page.getByTestId("track-page")).toBeVisible();

    // ── coin a tag from the tracker bar itself ──────────────────────
    // Labelling as you go is the whole point; a detour to a management
    // screen is what stops people tagging at all.
    await createTagInline(page, "tracker-tags", DEEP_WORK);
    await expect(page.getByTestId("tracker-tags")).toHaveAttribute(
      "data-tag-count",
      "1",
    );

    // ── an entry carrying it ────────────────────────────────────────
    const tagged = await logManualEntry(page, "Refactor the parser", ONE_HOUR);
    const chips = tagged.getByTestId("entry-tags-chips");
    await expect(chips).toBeVisible();
    await expect(chips).toContainText(DEEP_WORK);
    await expect(tagged.getByTestId("entry-tags")).toHaveAttribute(
      "data-tag-count",
      "1",
    );

    // ── a second entry with no tag, to prove the filter narrows ─────
    await page.getByTestId("tracker-tags").click();
    await page.getByTestId("tracker-tags-clear").click();
    await page.keyboard.press("Escape");
    const untagged = await logManualEntry(page, "Answer email", ONE_HOUR);
    await expect(untagged.getByTestId("entry-tags")).toHaveAttribute(
      "data-tag-count",
      "0",
    );

    // ── the tag now shows its usage on the management screen ────────
    await page.goto("/tags");
    await expect(page.getByTestId("tags-page")).toBeVisible();
    const tagRow = page
      .locator('[data-testid^="tag-row-"]')
      .filter({ hasText: DEEP_WORK });
    await expect(tagRow).toHaveCount(1);
    const tagId = await idFromTestId(tagRow, "tag-row-");
    await expect(page.getByTestId(`tag-entries-${tagId}`)).toHaveText("1");
    await expect(page.getByTestId(`tag-tracked-${tagId}`)).toHaveText(ONE_HOUR);

    // ── filter a report down to it ──────────────────────────────────
    await page.goto(`/reports${RANGE_QUERY}`);
    await expect(page.getByTestId("report-filters")).toBeVisible();
    // Both entries are in range before the filter is applied.
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      "2:00:00",
    );

    await page.getByTestId("filter-tags").click();
    await page.getByTestId(`filter-tags-option-${tagId}`).click();
    await page.keyboard.press("Escape");

    // The filter is in the URL, so the report link is shareable.
    await expect(page).toHaveURL(new RegExp(`tags=${tagId}`));
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      ONE_HOUR,
    );

    // ── and clearing it puts the other hour back ────────────────────
    await page.getByTestId("filter-clear").click();
    await expect(page).not.toHaveURL(/tags=/);
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      "2:00:00",
    );
  });

  test("groups a summary by tag, and says why the rows over-add", async ({
    page,
  }) => {
    await expect(page.getByTestId("track-page")).toBeVisible();

    // One entry carrying TWO tags is the interesting case: it lands in both
    // groups, so the groups sum to more than the total.
    await createTagInline(page, "tracker-tags", DEEP_WORK);
    await createTagInline(page, "tracker-tags", ON_SITE);
    await expect(page.getByTestId("tracker-tags")).toHaveAttribute(
      "data-tag-count",
      "2",
    );

    await logManualEntry(page, "Pairing at the client", ONE_HOUR);

    await page.goto(`/reports${RANGE_QUERY}&group=tag`);
    await expect(page.getByTestId("summary-table")).toBeVisible();

    // The total is the true, un-double-counted hour...
    await expect(page.getByTestId("summary-total-duration")).toHaveText(
      ONE_HOUR,
    );

    // ...while each tag's row claims the whole hour, which is correct and is
    // exactly why the caveat has to be on screen.
    const rows = page.locator('[data-testid^="summary-row-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: DEEP_WORK })).toContainText(ONE_HOUR);
    await expect(rows.filter({ hasText: ON_SITE })).toContainText(ONE_HOUR);

    await expect(page.getByTestId("summary-overlap-note")).toBeVisible();
    await expect(page.getByTestId("summary-overlap-note")).toContainText(
      "more than the total",
    );

    // Any other grouping partitions the entries, so the caveat must be gone.
    await page.goto(`/reports${RANGE_QUERY}&group=project`);
    await expect(page.getByTestId("summary-table")).toBeVisible();
    await expect(page.getByTestId("summary-overlap-note")).toHaveCount(0);
  });

  test("renames a tag, and archives rather than deletes one in use", async ({
    page,
  }) => {
    await expect(page.getByTestId("track-page")).toBeVisible();
    await createTagInline(page, "tracker-tags", DEEP_WORK);
    await logManualEntry(page, "Refactor the parser", ONE_HOUR);

    await page.goto("/tags");
    const tagRow = page
      .locator('[data-testid^="tag-row-"]')
      .filter({ hasText: DEEP_WORK });
    const tagId = await idFromTestId(tagRow, "tag-row-");

    // ── rename ──────────────────────────────────────────────────────
    await page.getByTestId(`tag-menu-${tagId}`).click();
    await page.getByTestId(`tag-edit-${tagId}`).click();
    await expect(page.getByTestId("tag-dialog")).toBeVisible();
    await page.getByTestId("tag-name-input").fill("focus block");
    await page.getByTestId("tag-submit").click();
    await expect(page.getByTestId("tag-dialog")).toBeHidden();
    await expect(page.getByTestId(`tag-name-${tagId}`)).toHaveText(
      "focus block",
    );

    // The rename reaches the entry that carries it, not just this table.
    await page.goto("/track");
    const entry = page
      .locator('[data-testid="entry-row"]')
      .filter({ hasText: "Refactor the parser" });
    await expect(entry.getByTestId("entry-tags-chips")).toContainText(
      "focus block",
    );

    // ── delete, which the server turns into an archive ──────────────
    await page.goto("/tags");
    await page.getByTestId(`tag-menu-${tagId}`).click();
    await page.getByTestId(`tag-delete-${tagId}`).click();
    const confirm = page.getByTestId("tag-confirm-delete");
    await expect(confirm).toBeVisible();
    // The dialog promises an archive, because that is what will happen.
    await expect(confirm).toContainText("archived rather than deleted");
    await page.getByTestId("confirm-accept").click();

    // Hidden from the live list, still there behind "Show archived".
    await expect(page.getByTestId(`tag-row-${tagId}`)).toHaveCount(0);
    await page.getByTestId("tags-show-archived").click();
    await expect(page.getByTestId(`tag-row-${tagId}`)).toHaveCount(1);
    await expect(page.getByTestId(`tag-row-${tagId}`)).toHaveAttribute(
      "data-archived",
      "true",
    );

    // And the time it labelled keeps its label — archiving is not a rewrite.
    await page.goto("/track");
    await expect(
      page
        .locator('[data-testid="entry-row"]')
        .filter({ hasText: "Refactor the parser" })
        .getByTestId("entry-tags-chips"),
    ).toContainText("focus block");
  });

  test("creates a tag from the management screen and applies it to a row", async ({
    page,
  }) => {
    await page.goto("/tags");
    await expect(page.getByTestId("tags-empty")).toBeVisible();

    await page.getByTestId("new-tag").click();
    await expect(page.getByTestId("tag-dialog")).toBeVisible();
    await page.getByTestId("tag-name-input").fill(ON_SITE);
    await page.getByTestId("tag-submit").click();
    await expect(page.getByTestId("tag-dialog")).toBeHidden();

    const tagRow = page
      .locator('[data-testid^="tag-row-"]')
      .filter({ hasText: ON_SITE });
    const tagId = await idFromTestId(tagRow, "tag-row-");
    await expect(page.getByTestId(`tag-entries-${tagId}`)).toHaveText("0");

    // A duplicate name is refused inline on the field, not in a toast.
    await page.getByTestId("new-tag").click();
    await page.getByTestId("tag-name-input").fill(ON_SITE.toUpperCase());
    await page.getByTestId("tag-submit").click();
    await expect(page.getByTestId("tag-name-error")).toBeVisible();
    await page.getByTestId("tag-cancel").click();

    // ── apply it to an existing entry from the row itself ───────────
    await page.goto("/track");
    const row = await logManualEntry(page, "Kickoff workshop", ONE_HOUR);
    await expect(row.getByTestId("entry-tags")).toHaveAttribute(
      "data-tag-count",
      "0",
    );

    // The chips update optimistically, so waiting on them would let the test
    // navigate away while `entries.update` is still in flight — the request is
    // then aborted and the tag never actually lands on the entry. Wait for the
    // write itself before asserting anything the server has to know about.
    const applied = page.waitForResponse(
      (response) =>
        response.url().includes("entries.update") && response.status() === 200,
    );
    await row.getByTestId("entry-tags").click();
    await page.getByTestId(`entry-tags-option-${tagId}`).click();
    await page.keyboard.press("Escape");
    await applied;

    await expect(row.getByTestId("entry-tags-chips")).toContainText(ON_SITE);

    // The manager picks the usage up on the next visit.
    await page.goto("/tags");
    await expect(page.getByTestId(`tag-entries-${tagId}`)).toHaveText("1");
    await expect(page.getByTestId(`tag-tracked-${tagId}`)).toHaveText(ONE_HOUR);
  });
});
