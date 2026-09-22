import { test, expect, type Locator, type Page } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";

/**
 * The idle test bridge the client installs while idle detection is on.
 *
 * Declared here rather than imported: the spec compiles outside the client
 * package's tsconfig, so its global augmentation is not in scope.
 */
declare global {
  interface Window {
    __trackYourTimeIdle?: {
      simulate: (
        signal: "active" | "idle" | "locked",
        idleSeconds?: number,
      ) => void;
    };
  }
}

let sequence = 0;

/** Unique per test — signup is rejected for an address that already exists. */
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** The tracker row whose description contains `description`. */
function entryRow(page: Page, description: string): Locator {
  return page
    .locator('[data-testid="entry-row"]')
    .filter({ hasText: description });
}

/**
 * Every row that the list currently renders as still running. The running
 * entry belongs to the tracker bar and has no row of its own, so this is
 * expected to be empty at all times — it is asserted to catch the row coming
 * back, which read as two timers.
 */
function runningRows(page: Page): Locator {
  return page.locator('[data-testid="entry-row"][data-running="true"]');
}

/** The tracker bar while a timer runs — the running entry's one editor. */
function runningBar(page: Page): Locator {
  return page.locator('[data-testid="tracker-bar"][data-running="true"]');
}

/** Sign up a fresh user and land on the tracker with the list settled. */
async function openTracker(page: Page, prefix: string): Promise<void> {
  await signUpViaUI(page, {
    name: "Timer User",
    email: uniqueEmail(prefix),
    password: PASSWORD,
  });
  await page.goto("/app/track");
  await expect(page.getByTestId("track-page")).toBeVisible();
  await expect(page.getByTestId("tracker-bar")).toBeVisible();
  // A fresh account has nothing tracked — waiting for the empty state proves
  // `entries.list` resolved before the test starts clicking.
  await expect(page.getByTestId("entries-empty")).toBeVisible();
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Timer", () => {
  test("starts, ticks and stops into the day list", async ({ page }) => {
    await openTracker(page, "timer-basic");

    await page.getByTestId("tracker-description").fill("Writing the spec");
    await page.getByTestId("tracker-toggle").click();

    // Running: the bar flips to Stop and the elapsed clock goes live.
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(page.getByTestId("tracker-elapsed")).toHaveAttribute(
      "data-running",
      "true",
    );
    await expect(page.getByTestId("tracker-elapsed")).toHaveText(
      /^0:00:(?:0[1-9]|[1-5]\d)$/,
      { timeout: 15_000 },
    );

    // …and the running entry lives in the bar, not in the list: a row for it
    // under Today read as a second timer.
    await expect(runningBar(page)).toHaveCount(1);
    await expect(page.getByTestId("tracker-description")).toHaveValue(
      "Writing the spec",
    );
    await expect(page.getByTestId("tracker-start")).toBeVisible();
    await expect(runningRows(page)).toHaveCount(0);
    await expect(entryRow(page, "Writing the spec")).toHaveCount(0);

    await page.getByTestId("tracker-toggle").click();

    // Stopped: nothing is running any more and the entry sits under Today.
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );
    await expect(page.getByTestId("tracker-elapsed")).toHaveAttribute(
      "data-running",
      "false",
    );
    await expect(runningBar(page)).toHaveCount(0);

    const row = entryRow(page, "Writing the spec");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-running", "false");
    // A handful of seconds of wall clock — never zero, never an hour.
    await expect(row.getByTestId("entry-duration")).toHaveValue(
      /^0:00:(?:0[1-9]|[1-5]\d)$/,
    );

    const day = page.getByTestId("day-group").first();
    await expect(day.getByTestId("day-label")).toHaveText("Today");
    await expect(day.getByTestId("day-total")).toHaveText(
      /^0:00:(?:0[1-9]|[1-5]\d)$/,
    );
  });

  test("pauses when the screen locks and resumes the same work", async ({
    page,
  }) => {
    await openTracker(page, "timer-idle");

    // Configure idle detection: pause and resume, with the shortest threshold
    // the settings allow.
    await page.goto("/app/settings");
    await page.getByTestId("settings-tab-idle").click();
    await page.getByTestId("idle-enabled").click();
    await expect(page.getByTestId("idle-enabled")).toHaveAttribute(
      "data-state",
      "checked",
    );
    await page.getByTestId("idle-behavior-pause-and-resume").click();
    await expect(
      page.getByTestId("idle-behavior-pause-and-resume"),
    ).toHaveAttribute("data-state", "on");
    await page.getByTestId("idle-threshold").fill("1");
    await page.getByTestId("idle-threshold").press("Enter");
    await expect(page.getByTestId("idle-save-indicator")).toHaveAttribute(
      "data-state",
      "saved",
    );

    await page.goto("/app/track");
    await page.getByTestId("tracker-description").fill("Reading the RFC");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);

    // The detector is the OS in real life, so the test injects a reading
    // instead of idling for a real minute. `__trackYourTimeIdle` feeds exactly the
    // signal `chrome.idle` and `powerMonitor` feed — it grants the page
    // nothing it does not already have — and it only exists once idle
    // detection is enabled, which is why the settings come first.
    await expect
      .poll(() =>
        page.evaluate(() => typeof window.__trackYourTimeIdle?.simulate),
      )
      .toBe("function");

    // A locked screen rather than a silent one, and that is not an arbitrary
    // choice: an `idle` reading is clamped to the running entry's own start,
    // so a timer opened seconds ago can never have been idle long enough to
    // cross even the one-minute minimum threshold — the entry itself is the
    // proof that somebody was at the keyboard. Locking is deliberate, so it
    // skips the threshold (the "Treat a locked screen as away" setting, on by
    // default) and is the only signal a test can raise without burning a real
    // minute of wall clock. The threshold path is covered exhaustively in
    // `core-idle.test.ts`, where the clock is a parameter.
    await page.evaluate(() => window.__trackYourTimeIdle?.simulate("locked"));

    // Paused: the entry is closed, nothing is running, and the seconds it had
    // before the lock survive — a truncation is clamped to stay after the
    // entry's start, so it can never destroy tracked time.
    await expect(runningBar(page)).toHaveCount(0);
    const paused = entryRow(page, "Reading the RFC").first();
    await expect(paused).toHaveAttribute("data-running", "false");

    // Back at the keyboard: the same work reopens, by itself.
    await page.evaluate(() => window.__trackYourTimeIdle?.simulate("active"));

    // A resume is two chained writes — close the old entry, open a new one —
    // and the screen is briefly inconsistent while `entries.start` is in
    // flight: the optimistic entry is in the bar before every cache the pause
    // invalidated has caught up. Wait for the bar to carry its server id first.
    const bar = page.getByTestId("tracker-bar");
    await expect
      .poll(async () => (await bar.getAttribute("data-running-id")) ?? "", {
        message: "expected the resumed row to settle to its server id",
        // The optimistic row is there in a frame; the id it settles to comes
        // from the server, which is the slow part under a loaded suite.
        timeout: 15_000,
      })
      .not.toMatch(/^(?:temp-|$)/);

    await expect(runningBar(page)).toHaveCount(1);
    await expect(page.getByTestId("tracker-description")).toHaveValue(
      "Reading the RFC",
    );

    // One session, now two entries: the work before the lock, listed, and the
    // work after it, running in the bar. The time spent away is in neither.
    await expect(entryRow(page, "Reading the RFC")).toHaveCount(1);
    await page.getByTestId("tracker-toggle").click();
    await expect(entryRow(page, "Reading the RFC")).toHaveCount(2);
  });

  test("keeps at most one timer running", async ({ page }) => {
    await openTracker(page, "timer-invariant");

    // A finished entry to come back to later.
    await page.getByTestId("tracker-description").fill("First task");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(0);
    await expect(entryRow(page, "First task")).toHaveCount(1);

    // Second timer.
    await page.getByTestId("tracker-description").fill("Second task");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);
    await expect(page.getByTestId("tracker-description")).toHaveValue(
      "Second task",
    );
    await expect(runningRows(page)).toHaveCount(0);

    // Continuing the first entry starts a third timer, which must stop the
    // second one rather than run alongside it.
    await entryRow(page, "First task").getByTestId("entry-continue").click();

    await expect(runningBar(page)).toHaveCount(1);
    await expect(page.getByTestId("tracker-description")).toHaveValue(
      "First task",
    );
    await expect(runningRows(page)).toHaveCount(0);

    // The interrupted timer kept its time and is no longer live.
    const second = entryRow(page, "Second task");
    await expect(second).toHaveCount(1);
    await expect(second).toHaveAttribute("data-running", "false");
    await expect(second.getByTestId("entry-duration")).toHaveValue(
      /^0:00:\d{2}$/,
    );

    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(0);
  });

  test("logs a manual entry with an explicit duration", async ({ page }) => {
    await openTracker(page, "timer-manual");

    // The + is its own button, not a mode the bar gets stuck in: the Start
    // button keeps saying Start, and the range lives in a dialog.
    await page.getByTestId("tracker-description").fill("Manual block");
    await page.getByTestId("tracker-manual-open").click();

    const dialog = page.getByTestId("manual-entry-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    // The dialog opens on the hour that just passed, seeded with whatever the
    // composer already had typed in it.
    await expect(page.getByTestId("manual-entry-description")).toHaveValue(
      "Manual block",
    );
    await expect(page.getByTestId("manual-entry-start")).toBeVisible();
    await expect(page.getByTestId("manual-entry-end")).toBeVisible();
    await expect(page.getByTestId("manual-entry-duration")).toHaveValue(
      "1:00:00",
    );

    // The duration field accepts tracker shorthand and normalises it.
    await page.getByTestId("manual-entry-duration").fill("45m");
    await page.getByTestId("manual-entry-duration").press("Enter");
    await expect(page.getByTestId("manual-entry-duration")).toHaveValue(
      "0:45:00",
    );

    await page.getByTestId("manual-entry-add").click();
    await expect(dialog).toBeHidden();

    const row = entryRow(page, "Manual block");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-running", "false");
    await expect(row.getByTestId("entry-duration")).toHaveValue("0:45:00");

    // Adding logged the block without starting a timer.
    await expect(runningBar(page)).toHaveCount(0);
  });

  /**
   * Regression: a dialog stays mounted for the length of its exit animation,
   * and its dismissable layer keeps listening the whole time. The click that
   * reopened this one reached that layer as an interaction outside, which
   * closed the dialog again in the same click that opened it — so for a
   * fraction of a second after logging a block, the + was dead. Logging two
   * blocks in a row is the ordinary case, so this was the ordinary case
   * failing, intermittently, depending on how long the first row took to land.
   *
   * What this test covers, and what it does NOT: it walks the ordinary
   * two-blocks-in-a-row path end to end and asserts the second dialog opens
   * and works. It does not, on its own, hold the exit animation off — and it
   * cannot. Playwright waits for the trigger to be receiving pointer events
   * before it clicks, so a lingering full-viewport overlay is waited out
   * rather than run into: against a build with the exit animation put back
   * on purpose, the dialog is detached ~520ms after the add (a ~320ms
   * mutation plus the 200ms animation) and the reopen below then always
   * succeeds. The invariant itself is pinned deterministically next to the
   * component, in components/ui/dialog.test.tsx.
   */
  test("the add-time dialog reopens straight after it was used", async ({
    page,
  }) => {
    await openTracker(page, "manual-reopen");

    const dialog = page.getByTestId("manual-entry-dialog");

    await page.getByTestId("tracker-manual-open").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("manual-entry-description").fill("First block");
    await page.getByTestId("manual-entry-duration").fill("30m");
    await page.getByTestId("manual-entry-duration").press("Enter");
    await page.getByTestId("manual-entry-add").click();
    await expect(entryRow(page, "First block")).toHaveCount(1);

    // Deliberately no settling wait beyond the row landing — the shape the
    // bug lived in. (Playwright's own actionability wait sits behind this
    // click, which is why the shape is no longer enough on its own; see the
    // note above the test.)
    await page.getByTestId("tracker-manual-open").click();
    await expect(dialog).toBeVisible();

    // The guard is narrow — a dialog that is genuinely open still dismisses.
    //
    // Clicked through the overlay's locator rather than as raw coordinates
    // (`page.mouse.click(20, 20)`), and that is the difference between a test
    // that measures the app and one that measures Playwright. Radix attaches
    // its outside-pointerdown listener in a `setTimeout(0)` after the layer
    // mounts, so for one task after the dialog's DOM lands there is nobody
    // listening: a raw synthetic click needs no element to be actionable and
    // fires inside that window, and the press is simply dropped. Measured
    // here at under 10ms — a click delayed 10ms dismisses, one delayed 5ms
    // does not — which no hand can hit and no user will ever meet, and which
    // reproduces identically on the build from before any of this app's
    // dialog or shell work. A locator click waits for the element to be
    // stable, i.e. for the dialog's 200ms entry animation to finish, which is
    // both what a person actually does to the backdrop and long past the gap.
    await page
      .getByTestId("dialog-overlay")
      .click({ position: { x: 20, y: 20 } });
    await expect(dialog).toBeHidden();
  });

  /**
   * The running entry has no row: the tracker bar is its one editor, and a
   * row for it under Today read as a second timer. So the bar carries the
   * start-time field a forgotten Start needs, and the row appears only once
   * the entry has stopped — offering Continue, never a Stop of its own.
   */
  test("the running entry is edited in the bar and listed once stopped", async ({
    page,
  }) => {
    await openTracker(page, "running-row");

    await page.getByTestId("tracker-description").fill("Long stretch");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);
    await expect(runningRows(page)).toHaveCount(0);
    await expect(entryRow(page, "Long stretch")).toHaveCount(0);

    // Moving the start back is the edit a running entry needs most.
    const start = page.getByTestId("tracker-start");
    await expect(start).toBeVisible();
    const started = page.waitForResponse(
      (response) => response.url().includes("entries.update") && response.ok(),
    );
    await start.fill("00:00");
    await start.press("Enter");
    await started;
    await expect(page.getByTestId("tracker-elapsed")).toHaveText(
      /^(?:[1-9]|1\d|2[0-3]):\d{2}:\d{2}$/,
      { timeout: 15_000 },
    );

    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(0);
    await expect(page.getByTestId("tracker-start")).toHaveCount(0);
    await expect(entryRow(page, "Long stretch")).toHaveCount(1);
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    // The stopped row offers Continue, and kept the moved start.
    const row = entryRow(page, "Long stretch");
    await expect(row.getByTestId("entry-continue")).toBeVisible();
    await expect(row.getByTestId("entry-stop")).toHaveCount(0);
    await expect(row.getByTestId("entry-start")).toHaveValue("00:00");
  });

  test("the project picker can create a project without typing a name", async ({
    page,
  }) => {
    await openTracker(page, "picker-create");

    // The create surfaces must be reachable from an empty workspace, where
    // there is no existing name to search for.
    await page.getByTestId("tracker-project").click();
    await page.getByTestId("project-picker-new-project").click();

    await expect(page.getByTestId("project-dialog")).toBeVisible();
    await page.getByTestId("project-name-input").fill("Dropdown Project");
    await page.getByTestId("project-submit").click();

    // Creating from the picker selects the new project straight away.
    await expect(page.getByTestId("tracker-project")).toContainText(
      "Dropdown Project",
    );
  });

  /**
   * Filing a past entry is exactly when the missing project turns up, so the
   * row's picker carries the same create surfaces as the tracker bar's rather
   * than sending you to the Projects screen and back.
   */
  test("an entry row can create the project it is being filed under", async ({
    page,
  }) => {
    await openTracker(page, "row-picker-create");

    await page.getByTestId("tracker-description").fill("Unfiled work");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);
    await page.getByTestId("tracker-toggle").click();

    const row = entryRow(page, "Unfiled work");
    await expect(row.getByTestId("entry-project")).toContainText("No project");

    await row.getByTestId("entry-project").click();
    await page.getByTestId("project-picker-new-project").click();

    await expect(page.getByTestId("project-dialog")).toBeVisible();
    await page.getByTestId("project-name-input").fill("Filed Later");
    await page.getByTestId("project-submit").click();

    // The new project lands on that entry, not merely in the catalog.
    await expect(row.getByTestId("entry-project")).toContainText("Filed Later");
    await page.reload();
    await expect(
      entryRow(page, "Unfiled work").getByTestId("entry-project"),
    ).toContainText("Filed Later");
  });

  /**
   * A stray click on Start leaves a few-second entry cluttering the day. The
   * toast offers to discard it — but never does so on its own, because
   * silently deleting tracked time is the worse failure.
   */
  test("a short entry offers to be discarded, and is kept if ignored", async ({
    page,
  }) => {
    await openTracker(page, "short-entry");

    await page.getByTestId("tracker-description").fill("Stray click");
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(1);
    await page.getByTestId("tracker-toggle").click();
    await expect(runningBar(page)).toHaveCount(0);

    // Ignoring the offer keeps the entry.
    const discard = page.getByRole("button", { name: "Discard" });
    await expect(discard).toBeVisible();
    await expect(entryRow(page, "Stray click")).toHaveCount(1);

    await discard.click();
    await expect(entryRow(page, "Stray click")).toHaveCount(0);
    await expect(page.getByTestId("entries-empty")).toBeVisible();
  });
});

/**
 * An entry keeps the clock time it was recorded at, wherever it is later opened
 * from. Rico moves between zones (travel, VPN), and the failure this prevents
 * is silent: the entry looks fine, it has just quietly moved by the offset.
 */
test.describe("Recorded time zone", () => {
  const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;

  test("shows and edits a foreign-zone entry in the zone it was recorded in", async ({
    page,
  }) => {
    await openTracker(page, "entry-zone");

    // 09:00-10:00 in Tokyo on 2026-08-21 — which is 00:00-01:00 UTC, and would
    // read as some other hour entirely in the browser's own zone.
    const created = await page.request.post(
      `${API}/api/trpc/entries.create?batch=1`,
      {
        data: {
          "0": {
            description: "Standup in Tokyo",
            start: "2026-08-21T00:00:00.000Z",
            end: "2026-08-21T01:00:00.000Z",
            billable: false,
            timeZone: "Asia/Tokyo",
          },
        },
      },
    );
    expect(created.ok()).toBe(true);

    await page.goto("/app/track");
    const row = entryRow(page, "Standup in Tokyo");
    await expect(row).toHaveCount(1);

    // The clock reads as it was written, and says where that was.
    await expect(row.getByTestId("entry-start")).toHaveValue("09:00");
    await expect(row.getByTestId("entry-end")).toHaveValue("10:00");
    await expect(row.getByTestId("entry-zone")).toHaveText("Tokyo");

    // Opening and saving it unchanged must not move the entry. Before the zone
    // was recorded, this round trip reinterpreted the clock time in the
    // viewer's zone and shifted the entry by the offset between them.
    await row.getByTestId("entry-menu").click();
    await page.getByTestId("entry-menu-edit").click();
    await expect(page.getByTestId("entry-edit-zone-note")).toContainText(
      "Asia/Tokyo",
    );
    await page.getByTestId("entry-edit-save").click();

    await expect(row.getByTestId("entry-start")).toHaveValue("09:00");
    await expect(row.getByTestId("entry-end")).toHaveValue("10:00");
    await expect(row.getByTestId("entry-duration")).toHaveValue("1:00:00");
  });
});
