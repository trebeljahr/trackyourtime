import { expect, test, type ElectronApplication } from "@playwright/test";

import { createAccount, launchApp, signInThroughForm, trpcCall, webSession } from "./support";

/*
 * Autopilot on top of desktop activity capture: fake capture of a filed app
 * → a timer started by itself, dated to when the work began, on the server
 * as an ordinary desktop entry → a toast that says so → the tray marks it and
 * pauses Autopilot for an hour → Undo deletes it.
 *
 * Headless as every desktop spec (support.ts): the fake frontmost source,
 * driven through `globalThis.__trackYourTimeDesktop.activity`, and nothing
 * spawned; no tray either, whose menu and title are read from the same hook. The capture clock is pinned a few minutes behind the real one, so
 * the renderer's "now" and main's agree on what is in the past.
 */

type Entry = { id: string; description: string; source: string; start: string; end: string | null; projectId: string | null };
type TrayItem = { type: "item"; id: string; label: string } | { type: "heading"; label: string } | { type: "separator" };

const MIN = 60_000;
const EDITOR = { key: "com.example.editor", name: "Editor" };

/** The renderer's activity bridge, as `page.evaluate` bodies see it. */
type RendererWindow = {
  electronAPI?: {
    activity?: {
      updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
      snapshot: () => Promise<{
        scoped: boolean;
        autopilot?: { owned: { start: number } | null; pausedUntil: number | null };
      }>;
      addRule: (rule: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

const hook = <T>(fn: string, arg?: unknown): Promise<T> =>
  app!.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    async (_electron, [body, value]) =>
      new Function("hook", "arg", body)(
        (globalThis as Record<string, { activity?: unknown }>).__trackYourTimeDesktop?.activity,
        value,
      ),
    [fn, arg] as const,
  ) as Promise<T>;

/** The tray, drawn from `globalThis.__trackYourTimeDesktop` (desktop.ts). */
const desktop = <T>(fn: string, arg?: unknown): Promise<T> =>
  app!.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (_electron, [body, value]) => new Function("hook", "arg", body)((globalThis as Record<string, unknown>).__trackYourTimeDesktop, value),
    [fn, arg] as const,
  ) as Promise<T>;

const trayIds = async (): Promise<string[]> =>
  (await desktop<TrayItem[]>("return hook.trayMenu()")).flatMap((item) => (item.type === "item" ? [item.id] : []));

/** `target` in front from `from` for `minutes`, one detection a minute at the pinned clock. */
async function frontFor(target: { key: string; name: string }, from: number, minutes: number): Promise<void> {
  await hook("hook.setFrontmost(arg)", target);
  for (let minute = 0; minute <= minutes; minute += 1) {
    await hook("hook.setNow(arg)", from + minute * MIN);
    await hook("return hook.tick()");
  }
}

test("Autopilot starts a filed app's timer from when the work began, and Undo takes it back", async () => {
  const account = await createAccount();
  const web = await webSession(account);
  const project = await trpcCall<{ id: string }>(web, "projects.create", { name: "Website" }, "mutation");

  const launched = await launchApp();
  app = launched.app;
  const { page } = launched;
  await signInThroughForm(page, account);
  expect(await hook<string | null>("return hook.sourceKind()")).toBe("fake");

  // Capture on, for this account, and a rule for the editor.
  await page.evaluate(() => (window as unknown as RendererWindow).electronAPI?.activity?.updateSettings({ enabled: true }));
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (window as unknown as RendererWindow).electronAPI?.activity?.snapshot())?.scoped ?? false,
      ),
    )
    .toBe(true);
  await page.evaluate(
    (projectId) =>
      (window as unknown as RendererWindow).electronAPI?.activity?.addRule({
        pattern: "com.example.editor",
        description: "Website redesign",
        projectId,
      }),
    project.id,
  );

  // Six minutes in the editor, ending a minute ago.
  const t0 = Date.now() - 7 * MIN;
  await frontFor(EDITOR, t0, 6);

  // Autopilot on: the driver mounts and plans at once.
  await page.evaluate(() => (window as unknown as RendererWindow).electronAPI?.activity?.updateSettings({ autopilot: true }));

  const toast = page.getByTestId("autopilot-toast");
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toHaveAttribute("data-kind", "start");
  await expect(page.getByTestId("autopilot-toast-title")).toContainText("Website redesign");

  // On the server: a running desktop entry, filed by the rule, from t0.
  const runningEntries = async (): Promise<Entry[]> =>
    (
      await trpcCall<{ entries: Entry[] }>(
        web,
        "entries.list",
        { from: new Date(t0 - 60 * MIN).toISOString(), to: new Date(Date.now() + 60 * MIN).toISOString() },
        "query",
      )
    ).entries;
  await expect
    .poll(async () =>
      (await runningEntries()).map((entry) => ({
        description: entry.description,
        projectId: entry.projectId,
        source: entry.source,
        start: entry.start,
        end: entry.end,
      })),
    )
    .toEqual([
      { description: "Website redesign", projectId: project.id, source: "desktop", start: new Date(t0).toISOString(), end: null },
    ]);

  // The tracker says who started it.
  await expect(page.getByTestId("tracker-bar")).toHaveAttribute("data-running", "true");
  const strip = page.getByTestId("autopilot-strip");
  await expect(strip).toHaveAttribute("data-kind", "owned");

  // The tray marks Autopilot's timer, and offers to pause Autopilot.
  await expect.poll(() => desktop<string>("return hook.trayTooltip()")).toMatch(/^✦ \d+:\d{2} · Website redesign$/);
  if (process.platform === "darwin") expect(await desktop<string>("return hook.trayTitle()")).toMatch(/^✦ \d+:\d{2}$/);
  await expect.poll(trayIds).toContain("autopilot-pause");

  // Paused from the tray: main holds back for an hour (of its pinned clock,
  // a minute behind the real one), and the tray and the strip say so. Its own
  // timer keeps running and stays its own.
  const pausedUntil = (): Promise<number | null> =>
    page.evaluate(
      async () => (await (window as unknown as RendererWindow).electronAPI?.activity?.snapshot())?.autopilot?.pausedUntil ?? null,
    );
  await desktop("hook.clickTray(arg)", "autopilot-pause");
  await expect.poll(pausedUntil).toBeGreaterThan(Date.now() + 50 * MIN);
  await expect.poll(trayIds).toContain("autopilot-resume");
  expect(await trayIds()).not.toContain("autopilot-pause");
  await expect(page.getByTestId("autopilot-strip-paused")).toBeVisible();
  await expect(strip).toHaveAttribute("data-kind", "owned");
  expect(await desktop<string>("return hook.trayTooltip()")).toMatch(/^✦ /);

  // Resumed from the strip.
  await page.getByTestId("autopilot-strip-resume").click();
  await expect.poll(pausedUntil).toBeNull();
  await expect.poll(trayIds).toContain("autopilot-pause");
  await expect(page.getByTestId("autopilot-strip-paused")).toHaveCount(0);

  // Undo from the strip: the entry is gone, and Autopilot holds off.
  await page.getByTestId("autopilot-strip-undo").click();
  await expect.poll(async () => (await runningEntries()).length).toBe(0);
  await expect(page.getByTestId("tracker-bar")).toHaveAttribute("data-running", "false");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (window as unknown as RendererWindow).electronAPI?.activity?.snapshot())?.autopilot?.owned ?? null,
      ),
    )
    .toBeNull();

  // The activity screen lists what Autopilot did, undone.
  await page.goto("app://-/app/activity/");
  await expect(page.getByTestId("autopilot-panel")).toHaveAttribute("data-state", "on");
  const logged = page.getByTestId("autopilot-log-entry");
  await expect(logged).toHaveCount(1);
  await expect(logged.first()).toHaveAttribute("data-undone", "true");
  await expect(page.getByTestId("activity-timeline")).toBeVisible();

  // The panel pauses and resumes too.
  await page.getByTestId("autopilot-pause").click();
  await expect(page.getByTestId("autopilot-paused")).toBeVisible();
  await expect.poll(trayIds).toContain("autopilot-resume");
  await page.getByTestId("autopilot-resume").click();
  await expect(page.getByTestId("autopilot-paused")).toHaveCount(0);
  await expect.poll(pausedUntil).toBeNull();

  expect(await hook<string[]>("return hook.spawns()")).toEqual([]);
});
