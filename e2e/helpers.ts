import { expect, type Locator, type Page } from "@playwright/test";

// next.config.ts sets `trailingSlash: true`, so every route resolves to a URL
// ending in "/". A plain string in waitForURL/toHaveURL is an exact match and
// would never match "/track/", so routes are matched by pattern instead.
export const TRACK_URL = /\/track\/?$/;
// The login page may carry a query: the protected layout sends a signed-out
// visitor to `/login/?next=<page>` (lib/safe-next.ts), and that redirect can
// also race the sign-out button's own navigation to the bare `/login`.
export const LOGIN_URL = /\/login\/?(\?.*)?$/;

export async function signUpViaUI(
  page: Page,
  opts: { name: string; email: string; password: string },
) {
  await page.goto("/signup");
  await page.getByTestId("signup-name").fill(opts.name);
  await page.getByTestId("signup-email").fill(opts.email);
  await page.getByTestId("signup-password").fill(opts.password);
  await page.getByTestId("signup-confirm-password").fill(opts.password);
  await page.getByTestId("signup-submit").click();
  // Wait for navigation to the tracker
  await page.waitForURL(TRACK_URL, { timeout: 10_000 });
}

export async function signInViaUI(
  page: Page,
  opts: { email: string; password: string },
) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(opts.email);
  await page.getByTestId("login-password").fill(opts.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(TRACK_URL, { timeout: 10_000 });
}

export async function signOutViaUI(page: Page) {
  // Sign out lives inside the user menu in the app shell, so the menu has to
  // be opened before the item exists in the DOM.
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(LOGIN_URL, { timeout: 10_000 });
}

/**
 * Log one manual entry from the tracker bar and wait for its row to land.
 *
 * The duration field anchors the end to the pre-filled start, so the tracked
 * seconds are exact rather than wall-clock — a report or invoice assertion
 * cannot afford a stopwatch's worth of slop.
 *
 * Returns the settled row, so a caller can go on asserting against it.
 */
export async function logManualEntry(
  page: Page,
  description: string,
  duration: string,
): Promise<Locator> {
  await page.getByTestId("tracker-manual-open").click();
  await page.getByTestId("manual-entry-description").fill(description);
  await page.getByTestId("manual-entry-duration").fill(duration);
  await page.getByTestId("manual-entry-duration").press("Enter");
  await expect(page.getByTestId("manual-entry-duration")).toHaveValue(duration);

  await page.getByTestId("manual-entry-add").click();

  // Adding closes the dialog, and closing unmounts it: dialogs animate in but
  // not out, precisely so nothing lingers over the page afterwards. Assert
  // both nodes are gone before returning — a click that landed while a
  // full-viewport overlay was still mounted would hit the overlay instead of
  // the button underneath and simply be lost, which is how calling this
  // helper twice in a row used to leave the second dialog unopened and the
  // fill() below waiting out its whole timeout.
  await expect(page.getByTestId("manual-entry-dialog")).toHaveCount(0);
  await expect(page.getByTestId("dialog-overlay")).toHaveCount(0);

  const row = page
    .locator('[data-testid="entry-row"]')
    .filter({ hasText: description });
  await expect(row).toHaveCount(1);
  // Wait for the server's real id before moving on. The row renders first with
  // the optimistic "temp-<id>" while `entries.create` is still in flight, and
  // navigating during that window aborts the request — which the offline queue
  // reads as a failure and replays, landing a duplicate entry.
  await expect
    .poll(async () => (await row.getAttribute("data-entry-id")) ?? "", {
      message: "expected the entry row to settle to its server id",
    })
    .not.toMatch(/^temp-/);
  await expect(row.getByTestId("entry-duration")).toHaveValue(duration);
  return row;
}
