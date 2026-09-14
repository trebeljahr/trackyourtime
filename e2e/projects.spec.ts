import { test, expect, type Locator, type Page } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection, getDb } from "./db-utils";

const PASSWORD = "SecurePassword123!";

const CLIENT_NAME = "Acme Inc.";
const PROJECT_NAME = "Website redesign";
const PROJECT_COLOR = "#14b8a6";
const PROJECT_RATE = "120";
const TASK_NAME = "Homepage hero";

let sequence = 0;

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

/**
 * Pick an option out of an open-on-click combobox. The trigger carries the
 * caller's test id; the portalled list is keyed by `combobox-option-<id>`,
 * whose ids are only known at runtime, so match on the visible label.
 */
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

/** The id embedded in a `<prefix>-<id>` test id on `row`. */
/**
 * Read the entity id out of a row's `data-testid`.
 *
 * Rows appear first as an optimistic placeholder whose id is a client-side
 * "optimistic-<uuid>", then get replaced when the server responds with the real
 * document. Reading the placeholder id yields locators that stop matching a
 * moment later, so wait for the real id before returning it.
 */
/**
 * Start the tracker and wait until the server has the entry.
 *
 * `data-state` flips optimistically, and a stop fired while `entries.start` is
 * still in flight can reach the server first: it finds nothing running, the
 * start then lands, and the timer stays on. That only shows under load, so a
 * test that stops right after starting waits for the start to answer.
 */
async function startAndSettle(page: Page): Promise<void> {
  const started = page.waitForResponse(
    (response) => response.url().includes("entries.start") && response.ok(),
  );
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
    "data-state",
    "running",
  );
  await started;
}

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

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Projects catalog", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Catalog User",
      email: uniqueEmail("projects"),
      password: PASSWORD,
    });
    await page.goto("/projects");
    await expect(page.getByTestId("projects-page")).toBeVisible();
  });

  test("creates a client, a project and a task, then tracks against it", async ({
    page,
  }) => {
    // ── client ──────────────────────────────────────────────────────
    await page.goto("/clients");
    await expect(page.getByTestId("clients-page")).toBeVisible();
    await expect(page.getByTestId("clients-empty")).toBeVisible();

    await page.getByTestId("new-client").click();
    await expect(page.getByTestId("client-dialog")).toBeVisible();
    await page.getByTestId("client-name-input").fill(CLIENT_NAME);
    await page.getByTestId("client-submit").click();

    await expect(page.getByTestId("client-dialog")).toBeHidden();
    const clientRow = page
      .locator('[data-testid^="client-row-"]')
      .filter({ hasText: CLIENT_NAME });
    await expect(clientRow).toHaveCount(1);

    // ── project, attached to that client, coloured and billed ───────
    await page.goto("/projects");
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page.getByTestId("projects-empty")).toBeVisible();

    await page.getByTestId("new-project").click();
    await expect(page.getByTestId("project-dialog")).toBeVisible();

    await page.getByTestId("project-name-input").fill(PROJECT_NAME);

    await page.getByTestId("project-color").click();
    await page
      .getByTestId(`project-color-swatch-${PROJECT_COLOR.replace("#", "")}`)
      .click();
    await expect(page.getByTestId("project-color")).toContainText(
      PROJECT_COLOR,
    );

    await pickComboboxOption(page, "project-client-combobox", CLIENT_NAME);
    await expect(page.getByTestId("project-client-combobox")).toContainText(
      CLIENT_NAME,
    );

    // Billing and limits are folded away on create.
    await expect(page.getByTestId("project-rate-input")).toBeHidden();
    await page.getByTestId("project-advanced-toggle").click();
    await page.getByTestId("project-rate-input").fill(PROJECT_RATE);
    await page.getByTestId("project-submit").click();

    await expect(page.getByTestId("project-dialog")).toBeHidden();

    const projectRow = page
      .locator('[data-testid^="project-row-"]')
      .filter({ hasText: PROJECT_NAME });
    await expect(projectRow).toHaveCount(1);
    // The row carries the client it was attached to and the rate it was given.
    await expect(projectRow).toContainText(CLIENT_NAME);

    const projectId = await idFromTestId(projectRow, "project-row-");
    await expect(page.getByTestId(`project-rate-${projectId}`)).toContainText(
      PROJECT_RATE,
    );
    await expect(page.getByTestId(`project-tracked-${projectId}`)).toHaveText(
      "0:00:00",
    );
    await expect(page.getByTestId(`project-entries-${projectId}`)).toHaveText(
      "0",
    );

    // ── task ────────────────────────────────────────────────────────
    // Tasks are their own catalog, not a project's children, so they are made
    // on their own screen and carry no project.
    await page.goto("/tasks");
    await expect(page.getByTestId("tasks-empty")).toBeVisible();

    await page.getByTestId("new-task").click();
    await page.getByTestId("task-name-input").fill(TASK_NAME);
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-dialog")).toBeHidden();

    const taskRow = page
      .locator('[data-testid^="task-row-"]')
      .filter({ hasText: TASK_NAME });
    await expect(taskRow).toHaveCount(1);

    const taskId = await idFromTestId(taskRow, "task-row-");
    await expect(page.getByTestId(`task-name-${taskId}`)).toHaveText(TASK_NAME);
    await expect(page.getByTestId(`task-total-${taskId}`)).toHaveText("0:00:00");

    // ── track against the project ───────────────────────────────────
    await page.goto("/track");
    await expect(page.getByTestId("track-page")).toBeVisible();
    await expect(page.getByTestId("entries-empty")).toBeVisible();

    await page.getByTestId("tracker-description").fill("Hero section markup");
    await pickComboboxOption(page, "tracker-project", PROJECT_NAME);
    await expect(page.getByTestId("tracker-project")).toContainText(
      PROJECT_NAME,
    );
    // The project is billable by default, so the bar adopts that.
    await expect(page.getByTestId("tracker-billable")).toHaveAttribute(
      "data-billable",
      "true",
    );

    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    // The chip on the entry names the project it was tracked against.
    const entry = page
      .locator('[data-testid="entry-row"]')
      .filter({ hasText: "Hero section markup" });
    await expect(entry).toHaveCount(1);
    await expect(entry.getByTestId("entry-project")).toContainText(
      PROJECT_NAME,
    );
    await expect(entry.getByTestId("entry-billable")).toHaveAttribute(
      "data-billable",
      "true",
    );

    // …and the catalog now counts that entry against the project.
    await page.goto("/projects");
    await expect(page.getByTestId(`project-entries-${projectId}`)).toHaveText(
      "1",
    );
  });

  test("filters the catalog by search and by client", async ({ page }) => {
    await page.goto("/clients");
    await expect(page.getByTestId("clients-page")).toBeVisible();
    await page.getByTestId("new-client").click();
    await page.getByTestId("client-name-input").fill(CLIENT_NAME);
    await page.getByTestId("client-submit").click();
    await expect(page.getByTestId("client-dialog")).toBeHidden();

    await page.goto("/projects");
    await expect(page.getByTestId("projects-page")).toBeVisible();

    for (const name of [PROJECT_NAME, "Internal tooling"]) {
      await page.getByTestId("new-project").click();
      await expect(page.getByTestId("project-dialog")).toBeVisible();
      await page.getByTestId("project-name-input").fill(name);
      if (name === PROJECT_NAME) {
        await pickComboboxOption(page, "project-client-combobox", CLIENT_NAME);
      }
      await page.getByTestId("project-submit").click();
      await expect(page.getByTestId("project-dialog")).toBeHidden();
    }

    const rows = page.locator('[data-testid^="project-row-"]');
    await expect(rows).toHaveCount(2);

    await page.getByTestId("catalog-search").fill("Internal");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Internal tooling");

    await page.getByTestId("catalog-search").fill("");
    await expect(rows).toHaveCount(2);

    await pickComboboxOption(page, "catalog-client-filter", CLIENT_NAME);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(PROJECT_NAME);
  });
  /**
   * Deleting a catalog row is a real delete, not an archive — and it never
   * takes tracked time with it. The entry survives, minus its references.
   */
  test("deleting a project keeps its time entries and its tasks", async ({
    page,
  }) => {
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name-input").fill(PROJECT_NAME);
    await page.getByTestId("project-submit").click();
    await expect(page.getByTestId("project-dialog")).toBeHidden();

    const projectRow = page
      .locator('[data-testid^="project-row-"]')
      .filter({ hasText: PROJECT_NAME });
    const projectId = await idFromTestId(projectRow, "project-row-");

    await page.goto("/tasks");
    await page.getByTestId("new-task").click();
    await page.getByTestId("task-name-input").fill(TASK_NAME);
    await page.getByTestId("task-submit").click();
    await expect(
      page.locator('[data-testid^="task-row-"]').filter({ hasText: TASK_NAME }),
    ).toHaveCount(1);

    // Track a minute against the project so it has entries to cascade over.
    await page.goto("/track");
    await page.getByTestId("tracker-description").fill("Doomed project work");
    await pickComboboxOption(page, "tracker-project", PROJECT_NAME);
    await startAndSettle(page);
    // `data-state` flips optimistically, so waiting on it alone lets the test
    // navigate while `entries.stop` is still in flight; the request is then
    // aborted and the entry stays open, with nothing on screen to say so.
    const stopped = page.waitForResponse(
      (response) =>
        response.url().includes("entries.stop") && response.status() === 200,
    );
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );
    await stopped;

    await page.goto("/projects");
    await expect(page.getByTestId(`project-entries-${projectId}`)).toHaveText(
      "1",
    );

    await page.getByTestId(`project-menu-${projectId}`).click();
    await page.getByTestId(`project-delete-${projectId}`).click();
    await expect(page.getByTestId("confirm-project-delete")).toBeVisible();
    await page.getByTestId("confirm-accept").click();

    // Gone for good — not archived. It stays gone with archived rows shown.
    await expect(projectRow).toHaveCount(0);
    await page.getByTestId("catalog-show-archived").click();
    await expect(projectRow).toHaveCount(0);

    // The task did NOT go with it: a task names the kind of work, not the
    // project it happened on, so it outlives the project.
    await page.goto("/tasks");
    await expect(page.getByTestId("tasks-page")).toBeVisible();
    await expect(
      page.locator('[data-testid^="task-row-"]').filter({ hasText: TASK_NAME }),
    ).toHaveCount(1);

    // The entry survived, and simply has no project any more.
    await page.goto("/track");
    const entry = page
      .locator('[data-testid="entry-row"]')
      .filter({ hasText: "Doomed project work" });
    await expect(entry).toHaveCount(1);
    await expect(entry.getByTestId("entry-project")).toContainText("No project");
  });

  test("edits billing in the table and asks before rewriting booked time", async ({
    page,
  }) => {
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name-input").fill(PROJECT_NAME);
    await page.getByTestId("project-submit").click();
    await expect(page.getByTestId("project-dialog")).toBeHidden();

    const projectRow = page
      .locator('[data-testid^="project-row-"]')
      .filter({ hasText: PROJECT_NAME });
    const projectId = await idFromTestId(projectRow, "project-row-");

    // No rate of its own: the cell names the workspace default it falls back to.
    await expect(page.getByTestId(`project-rate-${projectId}`)).toContainText(
      "default",
    );

    // Book one entry so there is history for a billing change to reach.
    await page.goto("/track");
    await page.getByTestId("tracker-description").fill("Billed work");
    await pickComboboxOption(page, "tracker-project", PROJECT_NAME);
    await startAndSettle(page);
    const stopped = page.waitForResponse(
      (response) =>
        response.url().includes("entries.stop") && response.status() === 200,
    );
    await page.getByTestId("tracker-toggle").click();
    await stopped;

    const entryRate = async (): Promise<unknown> => {
      const db = await getDb();
      const entry = await db
        .collection("timeentries")
        .findOne({ projectId, description: "Billed work" });
      return entry?.hourlyRate;
    };

    await page.goto("/projects");
    const billing = page.getByTestId(`project-billing-${projectId}`);

    // "Only new entries" saves the rate and leaves the entry's snapshot alone.
    await billing.click();
    await page.getByTestId("project-billing-rate").fill(PROJECT_RATE);
    await page.getByTestId("project-billing-save").click();
    await expect(page.getByTestId("apply-to-entries-count")).toContainText(
      "1 time entry",
    );
    await page.getByTestId("apply-to-entries-new-only").click();
    await expect(page.getByTestId(`project-rate-${projectId}`)).toContainText(
      PROJECT_RATE,
    );
    await expect(page.getByTestId(`project-rate-${projectId}`)).not.toContainText(
      "default",
    );
    expect(await entryRate()).not.toBe(Number(PROJECT_RATE));

    // Accepting carries the new rate onto the entry already booked.
    await billing.click();
    await page.getByTestId("project-billing-rate").fill("150");
    await page.getByTestId("project-billing-save").click();
    await page.getByTestId("apply-to-entries-accept").click();
    await expect(page.getByTestId(`project-rate-${projectId}`)).toContainText(
      "150",
    );
    await expect.poll(entryRate).toBe(150);

    // Turning billable off and applying clears the entry's flag and rate.
    await billing.click();
    await page.getByTestId("project-billing-billable").click();
    await page.getByTestId("project-billing-save").click();
    await page.getByTestId("apply-to-entries-accept").click();
    await expect(billing).toHaveAttribute("data-billable", "false");
    await expect.poll(entryRate).toBeNull();
  });

  /**
   * A client is a property OF a project, so it is made from the project dialog
   * rather than on a separate screen. A task is not — it stands on its own, and
   * is created from the task picker beside the project.
   */
  test("creates a client from the project dialog and a task from its picker", async ({
    page,
  }) => {
    await signUpViaUI(page, {
      name: "Layers User",
      email: uniqueEmail("layers"),
      password: PASSWORD,
    });
    await page.goto("/track");
    await expect(page.getByTestId("tracker-bar")).toBeVisible();

    await page.getByTestId("tracker-project").click();
    // Creating a client is NOT offered here: this picker chooses a project.
    await expect(page.getByTestId("project-picker-new-client")).toHaveCount(0);
    await page.getByTestId("project-picker-new-project").click();

    await expect(page.getByTestId("project-dialog")).toBeVisible();
    await page.getByTestId("project-name-input").fill("Mobile App");

    // A colour outside the palette must be accepted.
    await page.getByTestId("project-color").click();
    await page.getByTestId("project-color-hex").fill("#ff6b9d");
    await page.getByTestId("project-color-hex").press("Enter");
    await expect(page.getByTestId("project-color")).toContainText("#ff6b9d");

    // Client, coined from within the project being defined — one path, the
    // combobox's own create row, and the new client's colour is editable
    // right there rather than being whatever the server assigned.
    await page.getByTestId("project-client-combobox").click();
    await page.getByTestId("combobox-search").fill("Globex");
    await page.getByTestId("combobox-create").click();
    await expect(page.getByTestId("project-client-combobox")).toContainText(
      "Globex",
    );

    await page.getByTestId("project-client-color").click();
    await page.getByTestId("project-client-color-hex").fill("#22d3ee");
    await page.getByTestId("project-client-color-hex").press("Enter");
    await expect(page.getByTestId("project-client-color")).toContainText(
      "#22d3ee",
    );

    await page.getByTestId("project-submit").click();
    await expect(page.getByTestId("tracker-project")).toContainText("Mobile App");

    // The task picker is independent of the project: it opens whatever is
    // selected beside it, and a task created here belongs to no project.
    await page.getByTestId("tracker-task").click();
    await page.getByTestId("task-picker-new-task").click();
    await page.getByTestId("task-name-input").fill("Design");
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-dialog")).toBeHidden();
    await expect(page.getByTestId("tracker-task")).toContainText("Design");
  });
});
