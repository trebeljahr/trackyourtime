import { test, expect, type Locator, type Page } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";

let sequence = 0;

/** Unique per test — signup is rejected for an address that already exists. */
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

function entryRow(page: Page, description: string): Locator {
  return page
    .locator('[data-testid="entry-row"]')
    .filter({ hasText: description });
}

async function openTracker(page: Page, prefix: string): Promise<void> {
  await signUpViaUI(page, {
    name: "Palette User",
    email: uniqueEmail(prefix),
    password: PASSWORD,
  });
  await page.goto("/track");
  await expect(page.getByTestId("tracker-bar")).toBeVisible();
  await expect(page.getByTestId("entries-empty")).toBeVisible();
}

/** A billable-by-default project, created through the projects screen. */
async function createProject(page: Page, name: string): Promise<void> {
  await page.goto("/projects");
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await page.getByTestId("new-project").click();
  await page.getByTestId("project-name-input").fill(name);
  await page.getByTestId("project-submit").click();
  await expect(page.getByTestId("project-dialog")).toBeHidden();
}

/**
 * Click Start and wait for the server to confirm, not just for the optimistic
 * row: the bar re-seeds its fields when the temp id becomes the real one, and
 * a stop or an offline switch sent before that races the start itself.
 */
async function startFromBar(page: Page): Promise<void> {
  const started = page.waitForResponse(
    (response) => response.url().includes("entries.start") && response.ok(),
  );
  await page.getByTestId("tracker-toggle").click();
  await started;
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
    "data-state",
    "running",
  );
}

async function openPalette(page: Page): Promise<Locator> {
  const input = page.getByTestId("command-palette-input");
  // Retried: right after a navigation the static export may not have
  // hydrated yet, and a keystroke before the shell's listener exists is lost.
  await expect(async () => {
    if (!(await input.isVisible())) {
      await page.keyboard.press("ControlOrMeta+k");
    }
    await expect(input).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(input).toBeFocused();
  return input;
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Command palette", () => {
  test("opens on any protected page and starts a timer on a project", async ({
    page,
  }) => {
    await openTracker(page, "palette-start");
    await createProject(page, "Harbour Website");

    // A page that is not the tracker, so the shell's shortcut is what opens it.
    await page.goto("/timesheet");
    const input = await openPalette(page);
    await input.fill("Harbour Website");
    await expect(
      page.locator('[data-testid^="command-palette-item-start-project-"]'),
    ).toBeVisible();
    const started = page.waitForResponse(
      (response) => response.url().includes("entries.start") && response.ok(),
    );
    await input.press("Enter");
    await started;

    await expect(input).toBeHidden();
    await expect(page.getByTestId("running-timer-indicator")).toBeVisible();

    await page.goto("/track");
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(page.getByTestId("tracker-project")).toContainText(
      "Harbour Website",
    );

    // Escape closes it without running anything.
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette-input")).toBeHidden();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
  });

  test("stops the timer while offline and queues the stop", async ({
    page,
    context,
  }) => {
    await openTracker(page, "palette-offline");
    await page.getByTestId("tracker-description").fill("Offline stretch");
    await startFromBar(page);
    await expect(entryRow(page, "Offline stretch")).toHaveAttribute(
      "data-running",
      "true",
    );

    await context.setOffline(true);
    await expect(page.getByTestId("offline-indicator")).toBeVisible();

    const input = await openPalette(page);
    await input.fill("Stop timer");
    await expect(
      page.getByTestId("command-palette-item-timer-stop"),
    ).toBeVisible();
    await input.press("Enter");

    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );
    await expect(page.getByTestId("offline-pending")).toBeVisible();
    await expect(entryRow(page, "Offline stretch")).toHaveAttribute(
      "data-running",
      "false",
    );

    await context.setOffline(false);
    await expect(page.getByTestId("offline-pending")).toBeHidden({
      timeout: 15_000,
    });
    await page.reload();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });
});

test.describe("Tracker description autocomplete", () => {
  test("suggests past descriptions without taking over Enter", async ({
    page,
  }) => {
    await openTracker(page, "describe-enter");
    await createProject(page, "Lighthouse App");
    await page.goto("/track");

    // History: one entry filed under the project, billable by default.
    const description = page.getByTestId("tracker-description");
    await description.fill("Design review");
    await page.getByTestId("tracker-project").click();
    await page.getByTestId("combobox-search").fill("Lighthouse App");
    await page
      .locator('[data-testid^="combobox-option-"]')
      .filter({ hasText: "Lighthouse App" })
      .first()
      .click();
    await startFromBar(page);
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    // Typing shows it; Enter with nothing highlighted starts with the typed text.
    await description.fill("Design");
    await expect(
      page.getByTestId("tracker-description-suggestion").first(),
    ).toContainText("Design review");
    const started = page.waitForResponse(
      (response) => response.url().includes("entries.start") && response.ok(),
    );
    await description.press("Enter");
    await started;
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(description).toHaveValue("Design");
    await expect(page.getByTestId("tracker-project")).not.toContainText(
      "Lighthouse App",
    );
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    // The secondary action takes the project and billable flag along.
    await description.fill("review");
    const row = page
      .getByTestId("tracker-description-suggestion")
      .filter({ hasText: "Design review" });
    await expect(row).toBeVisible();
    await expect(page.getByTestId("tracker-description-suggestion")).toHaveCount(1);
    await description.press("ArrowDown");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await description.press("ControlOrMeta+Enter");

    await expect(description).toHaveValue("Design review");
    await expect(page.getByTestId("tracker-project")).toContainText(
      "Lighthouse App",
    );
    await expect(page.getByTestId("tracker-billable")).toHaveAttribute(
      "data-billable",
      "true",
    );
    // Taking a suggestion is not a start.
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });

  test("saves the running description on blur and reverts on Escape", async ({
    page,
  }) => {
    await openTracker(page, "describe-blur");
    const description = page.getByTestId("tracker-description");
    await description.fill("Draft");
    await startFromBar(page);
    await expect(entryRow(page, "Draft")).toHaveAttribute(
      "data-running",
      "true",
    );

    await description.fill("Draft two");
    await page.getByTestId("tracker-elapsed").click();
    await expect(entryRow(page, "Draft two")).toBeVisible();

    await page.reload();
    await expect(description).toHaveValue("Draft two");

    await description.fill("Abandoned wording");
    await expect(page.getByTestId("tracker-description-suggestion")).toHaveCount(0);
    await description.press("Escape");
    await expect(description).toHaveValue("Draft two");
    await expect(description).not.toBeFocused();

    await page.reload();
    await expect(description).toHaveValue("Draft two");
  });
});

test.describe("Calendar shortcuts", () => {
  test("d/w/m/y/t still navigate with the palette mounted", async ({ page }) => {
    await openTracker(page, "calendar-keys");
    await page.goto("/calendar");
    await expect(page.getByTestId("calendar-screen")).toBeVisible();
    const title = page.getByTestId("calendar-title");
    await expect(title).toBeVisible();

    for (const [key, view] of [
      ["m", "month"],
      ["y", "year"],
      ["d", "day"],
      ["w", "week"],
    ] as const) {
      await page.keyboard.press(key);
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
    }

    const today = await title.textContent();
    await page.getByTestId("calendar-next").click();
    await expect(title).not.toHaveText(today ?? "");
    await page.keyboard.press("t");
    await expect(title).toHaveText(today ?? "");

    // And Cmd/Ctrl+K on the calendar opens the palette rather than a view.
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/view=week/);
  });
});
