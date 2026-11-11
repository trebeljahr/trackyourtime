import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  createAccount,
  expect,
  launchApp,
  signInThroughForm,
  trpcCall,
  webSession,
  type DesktopApp,
} from "./support";

/*
 * The compact timer: one window that switches between the full app and a
 * small always-available timer, sharing one timer state with the tray and
 * every other client. Headless like every desktop spec (support.ts); the
 * window's size and position are read through the control channel.
 */

let app: DesktopApp | null = null;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

/** The window's position and size, in logical pixels. */
async function bounds(target: DesktopApp): Promise<{ x: number | null; y: number | null; width: number; height: number }> {
  const state = await target.windowState();
  if (!state) throw new Error("no main window");
  return { x: state.x, y: state.y, width: state.width, height: state.height };
}

async function size(target: DesktopApp): Promise<[number, number]> {
  const state = await target.windowState();
  if (!state) throw new Error("no main window");
  return [state.width, state.height];
}

/** A screenshot this spec takes for the store and for review, once the harness can. */
function screenshotNotPorted(name: string): void {
  test.info().annotations.push({
    type: "not ported",
    description: `screenshot ${name}: the e2e control channel cannot capture the hidden WebView yet (e2e.rs → screenshot)`,
  });
}

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
  await page.getByTestId("tracker-description").fill("Compact integration work");
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");
  const fullBounds = await bounds(app);
  await page.getByTestId("desktop-open-compact").click();
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await expect(page.getByTestId("compact-description")).toHaveText("Compact integration work");
  await expect
    .poll(async () => (await trpcCall<{ description: string } | null>(web, "entries.current", undefined, "query"))?.description)
    .toBe("Compact integration work");
  const previousClock = await page.getByTestId("compact-duration").textContent();
  await expect(page.getByTestId("compact-duration")).not.toHaveText(previousClock!);
  await expect(page.getByTestId("app-header")).not.toBeVisible();
  // Compact is the same window, resized — never a second one.
  expect((await app.windowState())?.windows).toBe(1);
  await expect.poll(() => size(app!)).toEqual([380, 540]);
  screenshotNotPorted("test-results/desktop-compact/running-light.png");
  await page.getByTestId("compact-primary").click();
  await expect.poll(() => trpcCall(web, "entries.current", undefined, "query")).toBeNull();
  await expect(page.getByTestId("compact-recent").first()).toContainText("Compact integration work");
  await page.getByTestId("compact-recent").first().click();
  await expect(page.getByTestId("compact-description")).toHaveText("Compact integration work");
  await expect
    .poll(async () => (await trpcCall<{ source: string } | null>(web, "entries.current", undefined, "query"))?.source)
    .toBe("desktop");
  await trpcCall(web, "entries.stop", {}, "mutation");
  await expect(page.getByTestId("compact-primary")).toHaveText("Start Timer");
  // A stopped compact timer's primary action expands the real composer.
  await page.getByTestId("compact-primary").click();
  await expect(page.getByTestId("tracker-description")).toBeFocused();
  await expect.poll(() => bounds(app!)).toEqual(fullBounds);
  await app.hook("clickTray", "compact");
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await app.hook("clickTray", "settings");
  await expect(page.getByTestId("compact-timer")).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/settings/);
  // No native tray, focus or keychain access occurs in this headless harness.
  expect((await app.windowState())?.visible).toBe(false);
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
  await expect(page.getByTestId("compact-recent").first()).toContainText("Offline compact recent");
  await app.context().setOffline(true);
  await page.getByTestId("compact-recent").first().click();
  await expect(page.getByTestId("compact-description")).toHaveText("Offline compact recent");
  await expect(page.getByTestId("compact-primary")).toBeEnabled();
  await page.getByTestId("compact-primary").click();
  await expect(page.getByTestId("compact-unsent")).toContainText("2 changes not sent yet");
  screenshotNotPorted("test-results/desktop-compact/offline.png");
  expect(await trpcCall(web, "entries.current", undefined, "query")).toBeNull();
  await app.context().setOffline(false);
  await expect(page.getByTestId("compact-unsent")).toHaveCount(0);
  await page.getByTestId("compact-pin").click();
  await expect(page.getByTestId("compact-pin")).toHaveAttribute("aria-pressed", "true");
  // The person resizes the compact window; that size is the one it keeps.
  await app.setWindowSize(430, 620);
  await expect.poll(() => size(app!)).toEqual([430, 620]);
  await page.getByTestId("compact-expand").click();
  await page.getByTestId("desktop-open-compact").click();
  await expect.poll(() => size(app!)).toEqual([430, 620]);
  const persistent = await page.evaluate(async () => (await window.electronAPI!.secureStore.status()).persistent);
  await app.close();
  app = null;
  const saved = JSON.parse(readFileSync(join(launched.userDataDir, "window-state.json"), "utf8"));
  expect(saved.mode).toBe("compact");
  expect(saved.alwaysOnTop).toBe(true);
  const relaunched = await launchApp(launched.userDataDir);
  app = relaunched.app;
  page = relaunched.page;
  if (!persistent) {
    // Linux without a Secret Service must not persist credentials in plain
    // text. Reauthenticate before restoring the preferred view.
    await page.waitForURL(/\/login/);
    expect((await page.evaluate(() => window.electronAPI!.desktop!.window!.getState())).mode).toBe("full");
    await signInThroughForm(page, account);
  }
  await expect(page.getByTestId("compact-timer")).toBeVisible();
  await expect(page.getByTestId("compact-pin")).toHaveAttribute("aria-pressed", "true");
  expect(await size(app)).toEqual([430, 620]);
  // The pin is remembered, but a headless run never floats a real window
  // above whoever is using the machine (window_presentation.rs → finish).
  expect((await page.evaluate(() => window.electronAPI!.desktop!.window!.getState())).alwaysOnTop).toBe(true);
  expect((await app.windowState())?.alwaysOnTop).toBe(false);
  await trpcCall(web, "settings.update", { theme: "dark" }, "mutation");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.locator("html")).not.toHaveClass(/\blight\b/);
  screenshotNotPorted("test-results/desktop-compact/idle-dark.png");
  await page.getByTestId("compact-expand").click();
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/\/login/);
  const snapshot = await page.evaluate(() => window.electronAPI!.desktop!.window!.getState());
  expect(snapshot.mode).toBe("full");
  await expect.poll(async () => (await size(app!))[0]).toBeGreaterThanOrEqual(800);
});
