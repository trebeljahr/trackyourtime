import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import {
  createAccount,
  launchApp,
  signInThroughForm,
  trpcCall,
  webSession,
  type Account,
} from "./support";

/*
 * Stages 4 and 5 of docs/desktop-app-plan.md: the tray, the global shortcuts,
 * Settings → Desktop and the notifications a hidden window needs.
 *
 * Every launch is headless (support.ts), so no tray icon, OS shortcut,
 * notification, dialog or badge is created. The main process records each on
 * `globalThis.__trackYourTimeDesktop` (electron/src/desktop.ts), and these
 * specs drive and read that hook through `app.evaluate` — the same handlers a
 * tray click, a hotkey or a notification click reaches. "From the web" is a
 * second session for the same account, as in sign-in.spec.ts.
 */

type TrayItem = { type: "item"; id: string; label: string } | { type: "heading"; label: string } | { type: "separator" };
type TimerState = { signedIn: boolean; running: { description: string } | null; unsent: number } | null;
type Entry = { id: string; description: string; source: string; end: string | null; start: string } | null;

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

const hook = <T>(fn: string, arg?: unknown): Promise<T> =>
  app!.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (_electron, [body, value]) => new Function("hook", "arg", body)((globalThis as Record<string, unknown>).__trackYourTimeDesktop, value),
    [fn, arg] as const,
  ) as Promise<T>;

const trayMenu = (): Promise<TrayItem[]> => hook<TrayItem[]>("return hook.trayMenu()");
const trayState = (): Promise<TimerState> => hook<TimerState>("return hook.state()");
const clickTray = (id: string): Promise<void> => hook<void>("hook.clickTray(arg)", id);
const trigger = (action: string): Promise<void> => hook<void>("hook.trigger(arg)", action);
const registered = (): Promise<string[]> => hook<string[]>("return hook.registered()");

async function signedInWithRecent(description: string): Promise<{
  page: Page;
  account: Account;
  web: string;
  userDataDir: string;
}> {
  const account = await createAccount();
  const web = await webSession(account);
  const end = new Date(Date.now() - 60 * 60_000);
  await trpcCall(
    web,
    "entries.create",
    { description, start: new Date(end.getTime() - 30 * 60_000).toISOString(), end: end.toISOString(), source: "web" },
    "mutation",
  );
  const launched = await launchApp();
  app = launched.app;
  await signInThroughForm(launched.page, account);
  await expect(launched.page.getByTestId("tracker-toggle")).toBeVisible();
  return { page: launched.page, account, web, userDataDir: launched.userDataDir };
}

const continueItem = async (label: string): Promise<string> => {
  let id = "";
  await expect
    .poll(async () => {
      const item = (await trayMenu()).find((candidate) => candidate.type === "item" && candidate.label === label);
      id = item && item.type === "item" ? item.id : "";
      return id.startsWith("continue:");
    })
    .toBe(true);
  return id;
};

test("start from the tray, stop from the web: the tray clears within a second", async () => {
  const { page, web } = await signedInWithRecent("Tray recent");

  // Signed in with a recent: Stop is absent, the recent is offered.
  const id = await continueItem("Tray recent");
  expect((await trayMenu()).some((item) => item.type === "item" && item.id === "stop")).toBe(false);

  await clickTray(id);
  await expect
    .poll(async () => {
      const current = await trpcCall<Entry>(web, "entries.current", undefined, "query");
      return current ? `${current.description}/${current.source}` : null;
    })
    .toBe("Tray recent/desktop");
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");
  await expect.poll(async () => (await trayMenu()).some((item) => item.type === "item" && item.id === "stop")).toBe(true);
  expect(await hook<string>("return hook.trayTooltip()")).toMatch(/^\d+:\d{2} · Tray recent$/);
  if (process.platform === "darwin") expect(await hook<string>("return hook.trayTitle()")).toMatch(/^\d+:\d{2}$/);

  await trpcCall(web, "entries.stop", {}, "mutation");
  const stoppedAt = Date.now();
  await expect.poll(async () => (await trayState())?.running ?? null, { timeout: 1000, intervals: [25] }).toBeNull();
  const cleared = Date.now() - stoppedAt;
  expect(cleared).toBeLessThan(1000);
  expect((await trayMenu()).some((item) => item.type === "item" && item.id === "stop")).toBe(false);
  console.log(`[tray] cleared ${cleared}ms after the web stop answered`);
});

test("the toggle shortcut stops and resumes with the window hidden", async () => {
  const { web } = await signedInWithRecent("Shortcut work");
  await continueItem("Shortcut work");
  const revealsBefore = await hook<number>("return hook.reveals()");

  // Only the default is registered, and only with the in-memory registrar.
  expect(await registered()).toEqual(["CommandOrControl+Alt+Shift+Space"]);

  // Nothing runs: the toggle continues the newest recent entry.
  await trigger("toggle-timer");
  await expect
    .poll(async () => (await trpcCall<Entry>(web, "entries.current", undefined, "query"))?.description ?? null)
    .toBe("Shortcut work");

  // Running: the toggle stops it.
  await trigger("toggle-timer");
  await expect.poll(async () => await trpcCall<Entry>(web, "entries.current", undefined, "query")).toBeNull();

  // Neither press showed or asked for the window.
  expect(await hook<number>("return hook.reveals()")).toBe(revealsBefore);
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);
  expect(await hook<{ kind: string }[]>("return hook.commands")).toEqual([{ kind: "toggle" }, { kind: "toggle" }]);
});

test("offline: start and stop from the tray are counted in the menu, flush when back, and warn on quit", async () => {
  const { page, web } = await signedInWithRecent("Offline tray");
  const id = await continueItem("Offline tray");
  const since = new Date().toISOString();

  await app!.context().setOffline(true);
  await clickTray(id);
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");
  await expect.poll(async () => (await trayState())?.running?.description ?? null).toBe("Offline tray");
  await clickTray("stop");
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "idle");

  await expect.poll(async () => (await trayState())?.unsent ?? 0).toBe(2);
  const menu = await trayMenu();
  expect(menu.some((item) => item.type === "heading" && item.label === "2 changes not sent yet")).toBe(true);
  // Nothing reached the server.
  expect(await trpcCall<Entry>(web, "entries.current", undefined, "query")).toBeNull();

  // Quitting now names the count. Emitted rather than quitting for real, so
  // the app is still there to read; the handler is the one a real quit runs.
  await app!.evaluate(({ app: electronApp }) => {
    electronApp.emit("before-quit", { preventDefault: () => undefined });
  });
  expect(await hook<{ title: string; body: string }[]>("return hook.quitNotices")).toEqual([
    {
      title: "2 changes are not sent yet",
      body: "They stay on this computer. Track Your Time sends them the next time it starts and reaches the server.",
    },
  ]);

  await app!.context().setOffline(false);
  await expect.poll(async () => (await trayState())?.unsent ?? -1, { timeout: 20_000 }).toBe(0);
  await expect
    .poll(async () => {
      const { entries } = await trpcCall<{ entries: Entry[] }>(
        web,
        "entries.list",
        { from: since, to: new Date(Date.now() + 60_000).toISOString(), limit: 20 },
        "query",
      );
      return entries.filter((entry) => entry?.description === "Offline tray" && entry.end !== null && entry.source === "desktop").length;
    })
    .toBe(1);
});

test("German: the tray draws the renderer's German labels", async () => {
  const { page, web } = await signedInWithRecent("Deutsch");
  await continueItem("Deutsch");
  await trpcCall(web, "settings.update", { locale: "de" }, "mutation");
  await page.reload();
  await expect
    .poll(async () => (await trayMenu()).flatMap((item) => (item.type === "item" ? [item.label] : [])))
    .toEqual(["Deutsch", "Timer starten …", "Track Your Time öffnen", "Einstellungen …", "Track Your Time beenden"]);
  expect((await trayMenu()).find((item) => item.type === "heading")).toEqual({ type: "heading", label: "Fortsetzen" });
});

test("Settings → Desktop rebinds, refuses a taken chord, clears, persists, and a shortcut opens the palette", async () => {
  test.setTimeout(120_000);
  const { page, userDataDir } = await signedInWithRecent("Settings");

  // The tray's Settings item lands on the Desktop tab.
  await clickTray("settings");
  await page.waitForURL(/\/app\/settings\/?\?tab=desktop$/);
  await expect(page.getByTestId("settings-panel-desktop")).toBeVisible();
  await expect(page.getByTestId("desktop-shortcut-value-toggle-timer")).toHaveAttribute(
    "data-accelerator",
    "CommandOrControl+Alt+Shift+Space",
  );

  // Recording suspends every registration so the press reaches the page.
  await page.getByTestId("desktop-shortcut-record-new-timer").click();
  await expect.poll(registered).toEqual([]);
  await page.keyboard.press("Control+Alt+KeyN");
  await expect(page.getByTestId("desktop-shortcut-value-new-timer")).toHaveAttribute("data-accelerator", "Control+Alt+N");
  await expect.poll(async () => (await registered()).sort()).toEqual(["CommandOrControl+Alt+Shift+Space", "Control+Alt+N"]);

  // A chord another application holds is saved but reported, not swallowed.
  await hook("hook.takeChord(arg)", "Control+Alt+K");
  await page.getByTestId("desktop-shortcut-record-open-palette").click();
  await page.keyboard.press("Control+Alt+KeyK");
  await expect(page.getByTestId("desktop-shortcut-problem-open-palette")).toHaveAttribute("data-problem", "taken");
  expect(await registered()).not.toContain("Control+Alt+K");

  // Rebind it to a free chord, then run it: the palette opens in the window.
  await page.getByTestId("desktop-shortcut-record-open-palette").click();
  await page.keyboard.press("Control+Alt+KeyP");
  await expect(page.getByTestId("desktop-shortcut-problem-open-palette")).toHaveCount(0);
  await expect.poll(registered).toContain("Control+Alt+P");
  await trigger("open-palette");
  await expect(page.getByTestId("command-palette-input")).toBeVisible();
  await page.keyboard.press("Escape");

  // Clearing the default unregisters it.
  await page.getByTestId("desktop-shortcut-clear-toggle-timer").click();
  await expect.poll(registered).not.toContain("CommandOrControl+Alt+Shift+Space");

  const stored = JSON.parse(readFileSync(join(userDataDir, "desktop-settings.json"), "utf8")) as {
    shortcuts: Record<string, string | null>;
  };
  expect(stored.shortcuts).toEqual({
    "toggle-timer": null,
    "new-timer": "Control+Alt+N",
    "toggle-window": null,
    "open-palette": "Control+Alt+P",
  });

  // A relaunch registers what was saved, before any page asks.
  await app!.close();
  const relaunched = await launchApp(userDataDir);
  app = relaunched.app;
  await expect.poll(async () => (await registered()).sort()).toEqual(["Control+Alt+N", "Control+Alt+P"]);
});

test("a runaway prompt posts a notification while hidden, and its click opens the prompt", async () => {
  const { page, web } = await signedInWithRecent("Runaway");
  await trpcCall(web, "settings.update", { maxDuration: { maxHours: 1, behavior: "ask" } }, "mutation");
  await trpcCall(
    web,
    "entries.start",
    { description: "Forgot to stop", start: new Date(Date.now() - 3 * 3600_000).toISOString(), source: "web" },
    "mutation",
  );
  // `entries.current` is one of the places the guard is enforced.
  await trpcCall(web, "entries.current", undefined, "query");

  await page.reload();
  await expect(page.getByTestId("runaway-prompt")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => hook<{ kind: string; title: string; body: string }[]>("return hook.notifications"))
    .toEqual([
      expect.objectContaining({
        kind: "runaway",
        body: "“Forgot to stop” is still running. Open Track Your Time to keep or correct it.",
      }),
    ]);

  // Away on another screen, the click brings the window back to the prompt.
  await page.getByTestId("nav-reports").click();
  await page.waitForURL(/\/app\/reports\//);
  const revealsBefore = await hook<number>("return hook.reveals()");
  await hook("hook.clickNotification(0)");
  await page.waitForURL(/\/app\/track\/?$/);
  expect(await hook<number>("return hook.reveals()")).toBe(revealsBefore + 1);
  await expect(page.getByTestId("runaway-prompt")).toBeVisible();

  // A window in front gets no notification: the prompt is already on screen.
  await hook("hook.pretendFocused(true)");
  const posted = await page.evaluate(() =>
    window.electronAPI!.desktop.notify({ kind: "idle", title: "In front", body: "", tag: "idle" }),
  );
  expect(posted).toBe(false);

  // The running badge follows its setting and the running timer; the login
  // item never reaches the OS in a headless run.
  expect(await hook<boolean>("return hook.badge()")).toBe(false);
  const update = await page.evaluate(() =>
    window.electronAPI!.desktop.updateSettings({ runningBadge: true, openAtLogin: true }),
  );
  expect(update.snapshot.loginItem).toBe("enabled");
  expect(await hook<boolean>("return hook.badge()")).toBe(true);
});
