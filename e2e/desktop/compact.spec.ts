import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  createAccount,
  launchApp,
  signInThroughForm,
  trpcCall,
  webSession,
} from "./support";

let app: ElectronApplication | null = null;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

test("one window shares timer state across compact, full, tray and another client", async () => {
  const account = await createAccount();
  const web = await webSession(account);
  const launched = await launchApp();
  app = launched.app;
  const page = launched.page;
  await signInThroughForm(page, account);
  // The shell mounts before the new account's workspace and socket finish
  // hydrating. Do not start work under that temporary, unscoped identity.
  await expect(page.getByTestId("workspace-switcher")).toHaveAttribute("data-workspace-id", /.+/);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-status", "open");
  await page
    .getByTestId("tracker-description")
    .fill("Compact integration work");
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
    "data-state",
    "running",
  );
  const fullBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds(),
  );
  await page.getByTestId("desktop-open-compact").click();
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await expect(page.getByTestId("compact-description")).toHaveText(
    "Compact integration work",
  );
  await expect.poll(async () => (await trpcCall<{ description: string } | null>(web, "entries.current", undefined, "query"))?.description).toBe("Compact integration work");
  const previousClock = await page.getByTestId("compact-duration").textContent();
  await expect(page.getByTestId("compact-duration")).not.toHaveText(previousClock!);
  await expect(page.getByTestId("app-header")).not.toBeVisible();
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([380, 540]);
  // A never-shown X11 window has no screenshot frames. Rendering evidence is
  // collected on macOS; the same behavioral assertions still run in Linux CI.
  if (process.platform === "darwin")
    await page.screenshot({
      path: "test-results/desktop-compact/running-light.png", animations: "disabled",
    });
  await page.getByTestId("compact-primary").click();
  await expect
    .poll(() => trpcCall(web, "entries.current", undefined, "query"))
    .toBeNull();
  await expect(page.getByTestId("compact-recent").first()).toContainText(
    "Compact integration work",
  );
  await page.getByTestId("compact-recent").first().click();
  await expect(page.getByTestId("compact-description")).toHaveText(
    "Compact integration work",
  );
  await expect
    .poll(
      async () =>
        (
          await trpcCall<{ source: string } | null>(
            web,
            "entries.current",
            undefined,
            "query",
          )
        )?.source,
    )
    .toBe("desktop");
  await trpcCall(web, "entries.stop", {}, "mutation");
  await expect(page.getByTestId("compact-primary")).toHaveText("Start Timer");
  // A stopped compact timer's primary action expands the real composer.
  await page.getByTestId("compact-primary").click();
  await expect(page.getByTestId("tracker-description")).toBeFocused();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
  ).toEqual(fullBounds);
  await app.evaluate(() =>
    (globalThis as Record<string, any>).__trackYourTimeDesktop.clickTray(
      "compact",
    ),
  );
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await app.evaluate(() =>
    (globalThis as Record<string, any>).__trackYourTimeDesktop.clickTray(
      "settings",
    ),
  );
  await expect(page.getByTestId("compact-timer")).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/settings/);
  // No native tray, focus or keychain access occurs in this headless harness.
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ),
  ).toBe(false);
});

test("compact offline actions share the queue, then reconnect and preserve mode across relaunch", async () => {
  const account = await createAccount();
  const web = await webSession(account);
  await trpcCall(
    web,
    "entries.create",
    {
      description: "Offline compact recent",
      start: new Date(Date.now() - 3_600_000).toISOString(),
      end: new Date(Date.now() - 1_800_000).toISOString(),
      source: "web",
    },
    "mutation",
  );
  const launched = await launchApp();
  app = launched.app;
  let page = launched.page;
  await signInThroughForm(page, account);
  await page.getByTestId("desktop-open-compact").click();
  await expect(page.getByTestId("compact-recent").first()).toContainText(
    "Offline compact recent",
  );
  await app.context().setOffline(true);
  await page.getByTestId("compact-recent").first().click();
  await expect(page.getByTestId("compact-description")).toHaveText(
    "Offline compact recent",
  );
  await expect(page.getByTestId("compact-primary")).toBeEnabled();
  await page.getByTestId("compact-primary").click();
  await expect(page.getByTestId("compact-unsent")).toContainText(
    "2 changes not sent yet",
  );
  if (process.platform === "darwin")
    await page.screenshot({ path: "test-results/desktop-compact/offline.png" });
  expect(await trpcCall(web, "entries.current", undefined, "query")).toBeNull();
  await app.context().setOffline(false);
  await expect(page.getByTestId("compact-unsent")).toHaveCount(0);
  await page.getByTestId("compact-pin").click();
  await expect(page.getByTestId("compact-pin")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(430, 620),
  );
  await page.getByTestId("compact-expand").click();
  await page.getByTestId("desktop-open-compact").click();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([430, 620]);
  const persistent = await page.evaluate(
    async () => (await window.electronAPI!.secureStore.status()).persistent,
  );
  await app.close();
  app = null;
  const saved = JSON.parse(
    readFileSync(join(launched.userDataDir, "window-state.json"), "utf8"),
  );
  expect(saved.mode).toBe("compact");
  expect(saved.alwaysOnTop).toBe(true);
  const relaunched = await launchApp(launched.userDataDir);
  app = relaunched.app;
  page = relaunched.page;
  if (!persistent) {
    // Linux without a Secret Service must not persist credentials with the
    // basic_text backend. Reauthenticate before restoring the preferred view.
    await page.waitForURL(/\/login/);
    expect(
      (
        await page.evaluate(() =>
          window.electronAPI!.desktop!.window!.getState(),
        )
      ).mode,
    ).toBe("full");
    await signInThroughForm(page, account);
  }
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await expect(page.getByTestId("compact-pin")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([430, 620]);
  await trpcCall(web, "settings.update", { theme: "dark" }, "mutation");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.locator("html")).not.toHaveClass(/\blight\b/);
  if (process.platform === "darwin")
    await page.screenshot({
      path: "test-results/desktop-compact/idle-dark.png", animations: "disabled",
    });
  await page.getByTestId("compact-expand").click();
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/\/login/);
  const snapshot = await page.evaluate(() =>
    window.electronAPI!.desktop!.window!.getState(),
  );
  expect(snapshot.mode).toBe("full");
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize().at(0),
    ),
  ).toBeGreaterThanOrEqual(800);
});
