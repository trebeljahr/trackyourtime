import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { createAccount, launchApp, signInThroughForm, trpcCall, webSession } from "./support";

/*
 * Stage 8 of docs/desktop-app-plan.md, Stage 2 of its design: desktop
 * activity capture → a suggestion on /app/activity → an entry.
 *
 * Every launch is headless (support.ts), so capture reads the FAKE frontmost
 * source that `globalThis.__trackYourTimeDesktop.activity` drives — never the
 * app actually in front on the machine running the suite — and never spawns a
 * process or asks the OS for a permission. The clock is pinned through the
 * same hook, so the recorded blocks sit at fixed times yesterday.
 */

type Files = { state: { scope: string | null; rules: unknown[]; dismissals: unknown[] } | null; open: unknown; segments: unknown[] };
type Entry = { id: string; description: string; source: string; start: string; end: string | null };

const MIN = 60_000;

/** The renderer's activity bridge, as `page.evaluate` bodies see it. */
type RendererWindow = {
  electronAPI?: {
    activity?: {
      updateSettings: (patch: { enabled: boolean }) => Promise<unknown>;
      snapshot: () => Promise<{ scoped: boolean }>;
    };
  };
};
const EDITOR = { key: "com.example.editor", name: "Editor" };
const CHAT = { key: "com.example.chat", name: "Chat" };

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

/** `app` in front from `from` for `minutes`, one detection a minute at the pinned clock. */
async function frontFor(target: { key: string; name: string }, from: number, minutes: number): Promise<void> {
  await hook("hook.setFrontmost(arg)", target);
  for (let minute = 0; minute <= minutes; minute += 1) {
    await hook("hook.setNow(arg)", from + minute * MIN);
    await hook("return hook.tick()");
  }
}

/** Nothing in front at `at`: closes the open segment there. */
async function nothingAt(at: number): Promise<void> {
  await hook("hook.setFrontmost(null)");
  await hook("hook.setNow(arg)", at);
  await hook("return hook.tick()");
}

/** Yesterday at `hour`:00, local time — always in the past, always one day. */
function yesterdayAt(hour: number): number {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

const dayKey = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

async function openActivity(page: Page, day: string): Promise<void> {
  await page.goto(`app://-/app/activity/?day=${day}`);
  await expect(page.getByTestId("activity-screen")).toBeVisible();
}

test("fake capture becomes a suggestion, and Add files it as a desktop entry", async () => {
  const account = await createAccount();
  const web = await webSession(account);
  const launched = await launchApp();
  app = launched.app;
  const { page } = launched;
  await signInThroughForm(page, account);

  // Headless: the fake source, and nothing spawned — ever.
  expect(await hook<string | null>("return hook.sourceKind()")).toBe("fake");
  expect(await hook<string[]>("return hook.spawns()")).toEqual([]);

  // Capture is off by default. Turn it on through the bridge (the Settings
  // card is Stage 3), then wait for the shell to publish whose activity it is.
  await page.evaluate(() => (window as unknown as RendererWindow).electronAPI?.activity?.updateSettings({ enabled: true }));
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (window as unknown as RendererWindow).electronAPI?.activity?.snapshot())?.scoped ?? false,
      ),
    )
    .toBe(true);
  await expect.poll(() => hook<boolean>("return hook.capturing()")).toBe(true);

  // The nav item shows, because capture works on this (simulated) channel.
  await expect(page.getByTestId("nav-activity")).toBeVisible();

  // 25 minutes of Editor, 2 of Chat, then nothing.
  const t0 = yesterdayAt(10);
  await frontFor(EDITOR, t0, 25);
  await frontFor(CHAT, t0 + 25 * MIN, 2);
  await nothingAt(t0 + 27 * MIN);

  await openActivity(page, dayKey(t0));
  const cards = page.getByTestId("activity-suggestion");
  await expect(cards).toHaveCount(1);
  await expect(cards.first().getByTestId("activity-suggestion-apps")).toContainText("Editor");
  await expect(cards.first()).toHaveAttribute("data-start", String(t0));

  const addedAt = Date.now();
  await cards.first().getByTestId("activity-suggestion-add").click();
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId("activity-empty")).toBeVisible();

  // The entry exists on the server, stamped `desktop`, over the block.
  await expect
    .poll(async () => {
      const list = await trpcCall<{ entries: Entry[] }>(
        web,
        "entries.list",
        { from: new Date(t0 - 60 * MIN).toISOString(), to: new Date(t0 + 120 * MIN).toISOString() },
        "query",
      );
      return list.entries.map((entry) => ({ source: entry.source, start: entry.start }));
    })
    .toEqual([{ source: "desktop", start: new Date(t0).toISOString() }]);
  expect(addedAt).toBeLessThan(Date.now());

  // A second block is dismissed; activity after it surfaces on its own.
  const t1 = t0 + 60 * MIN;
  await frontFor(EDITOR, t1, 15);
  await nothingAt(t1 + 15 * MIN);
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-start", String(t1));
  await cards.first().getByTestId("activity-suggestion-dismiss").click();
  await expect(cards).toHaveCount(0);

  const t2 = t1 + 30 * MIN;
  await frontFor(CHAT, t2, 10);
  await nothingAt(t2 + 10 * MIN);
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-start", String(t2));
  await expect(cards.first().getByTestId("activity-suggestion-apps")).toContainText("Chat");

  // Sign-out forgets everything recorded for this account; the settings stay.
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/^app:\/\/-\/login\//);
  await expect
    .poll(async () => {
      const files = await hook<Files>("return hook.files()");
      return {
        scope: files.state?.scope ?? null,
        rules: files.state?.rules.length ?? 0,
        dismissals: files.state?.dismissals.length ?? 0,
        open: files.open,
        segments: files.segments.length,
      };
    })
    .toEqual({ scope: null, rules: 0, dismissals: 0, open: null, segments: 0 });

  expect(await hook<string[]>("return hook.spawns()")).toEqual([]);
});

test("the nav has no Activity item where capture cannot work", async () => {
  const account = await createAccount();
  const launched = await launchApp();
  app = launched.app;
  const { page } = launched;
  await hook("return hook.setSupport(arg)", { supported: false, reason: "store", hint: null });
  await signInThroughForm(page, account);
  await expect(page.getByTestId("nav-track")).toBeVisible();
  await expect(page.getByTestId("nav-activity")).toHaveCount(0);
});
