import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import {
  API_ORIGIN,
  APP_ORIGIN,
  apiRequests,
  appRequests,
  createAccount,
  launchApp,
  signInThroughForm,
  trpcCall,
  webSession,
  type Account,
} from "./support";

/*
 * Stage 2 of docs/desktop-app-plan.md: signed in on the desktop app, with the
 * bearer token the phone apps use and no cookie anywhere.
 *
 * "From the web" in these specs is a second session for the same account,
 * made from Node (support.ts `webSession`), so the desktop app's own session
 * is the only one under test. The server-side request log
 * (record-requests.mjs) is what proves what the app sent.
 */

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

type DeviceRow = { id: string; name: string; client: string; current: boolean };
type Entry = { id: string; source: string; description: string; end: string | null } | null;

async function signedIn(): Promise<{ page: Page; account: Account; userDataDir: string; since: number }> {
  const since = Date.now();
  const launched = await launchApp();
  app = launched.app;
  const account = await createAccount();
  await signInThroughForm(launched.page, account);
  await expect(launched.page.getByTestId("tracker-toggle")).toBeVisible();
  return { page: launched.page, account, userDataDir: launched.userDataDir, since };
}

/** The socket is up: its upgrade reached the server, and the app says so. */
async function socketOpen(since: number): Promise<void> {
  await expect
    .poll(() => appRequests(since).filter((r) => r.kind === "upgrade").length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

test("control: the server-side log does see a cookie when one is sent", async () => {
  // Without this, "no request carried a Cookie" could be a recorder that never
  // notices one. The Stage 1 stand-in's method: the main process adds one.
  const since = Date.now();
  const launched = await launchApp();
  app = launched.app;
  await launched.page.waitForURL(/\/login\//);
  await app.evaluate(({ session }, api) => {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${api}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, Cookie: "control=1" } });
    });
  }, API_ORIGIN);
  await launched.page.evaluate((api) => fetch(`${api}/api/health`).then((r) => r.status), API_ORIGIN);
  await expect
    .poll(() => appRequests(since).some((r) => r.url === "/api/health" && r.cookie))
    .toBe(true);
});

test("signs in through the form; the server sees a bearer token and never a cookie", async () => {
  const { page, account, since } = await signedIn();
  await socketOpen(since);

  // Start a timer from the desktop app itself.
  await page.getByTestId("tracker-description").fill("Written on the desktop");
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");

  const web = await webSession(account);
  const current = await trpcCall<Entry>(web, "entries.current", undefined, "query");
  expect(current?.description).toBe("Written on the desktop");
  expect(current?.source).toBe("desktop");

  // Settings → Devices names this session.
  await page.goto(`${APP_ORIGIN}/app/settings/?tab=devices`);
  const devices = page.getByTestId("devices-table");
  await expect(devices).toBeVisible();
  const own = devices.locator("tr", { has: page.getByTestId("device-current-badge") });
  await expect(own).toContainText("Desktop app");
  const rows = await trpcCall<DeviceRow[]>(web, "devices.list", undefined, "query");
  expect(rows.filter((row) => row.client === "desktop")).toHaveLength(1);

  // What reached the server from the app's origin.
  const fromApp = appRequests(since);
  const trpc = fromApp.filter((r) => r.kind === "request" && r.url.startsWith("/api/trpc/") && r.method !== "OPTIONS");
  const upgrades = fromApp.filter((r) => r.kind === "upgrade");
  const signIn = fromApp.filter((r) => r.url.startsWith("/api/auth/sign-in/email") && r.method === "POST");
  expect(signIn).toHaveLength(1);
  expect(trpc.length).toBeGreaterThan(3);
  expect(upgrades.length).toBeGreaterThan(0);

  // The whole claim: not one request from the app carried a Cookie.
  expect(fromApp.filter((r) => r.cookie)).toEqual([]);
  // After sign-in, every tRPC call is bearer and names the desktop app, and
  // the socket authenticates with the bearer subprotocol.
  const afterSignIn = trpc.filter((r) => r.at >= signIn[0].at);
  expect(afterSignIn.filter((r) => r.authorization !== "Bearer")).toEqual([]);
  expect(afterSignIn.filter((r) => r.client !== "trackyourtime-desktop")).toEqual([]);
  expect(upgrades.every((r) => r.protocol === "bearer")).toBe(true);
});

test("a timer started on the web appears in the app within a second", async () => {
  const { page, account, since } = await signedIn();
  await socketOpen(since);
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "idle");
  const web = await webSession(account);

  await trpcCall(web, "entries.start", { description: "Started on the web", source: "web" }, "mutation");
  const started = Date.now();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running", { timeout: 1000 });
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(page.getByTestId("tracker-description")).toHaveValue("Started on the web");
});

test("quit and relaunch stays signed in, and the token on disk is ciphertext", async () => {
  const { page, userDataDir } = await signedIn();
  const status = await page.evaluate(() => window.electronAPI!.secureStore.status());
  await app!.close();
  app = null;

  const sessionFile = join(userDataDir, "session.bin");
  if (!status.persistent) {
    // Linux with no keyring: nothing written, signed out again, and said so.
    expect(existsSync(sessionFile)).toBe(false);
    const relaunched = await launchApp(userDataDir);
    app = relaunched.app;
    await relaunched.page.waitForURL(/\/login\//);
    return;
  }

  const bytes = readFileSync(sessionFile);
  expect(bytes.length).toBeGreaterThan(16);
  // A better-auth token is "<id>.<signature>": no such text may be on disk.
  expect(bytes.toString("latin1")).not.toMatch(/[A-Za-z0-9]{20,}\.[A-Za-z0-9+/=_-]{20,}/);

  const relaunched = await launchApp(userDataDir);
  app = relaunched.app;
  await relaunched.page.waitForURL(/^app:\/\/-\/app\/track\//, { timeout: 20_000 });
  await expect(relaunched.page.getByTestId("tracker-toggle")).toBeVisible();
});

test("revoked from the web: the socket closes and the app lands on /login with the unsent count", async () => {
  test.setTimeout(150_000);
  const { page, account, since } = await signedIn();
  await socketOpen(since);

  // One unsent change: the start fails as a network error (the request is
  // cancelled before it leaves), so the offline queue keeps it.
  await app!.evaluate(({ session }, api) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: [`${api}/api/trpc/entries.start*`] }, (_details, callback) =>
      callback({ cancel: true }),
    );
  }, API_ORIGIN);
  await page.getByTestId("tracker-description").fill("Queued, never sent");
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("offline-pending")).toBeVisible({ timeout: 15_000 });

  const web = await webSession(account);
  const rows = await trpcCall<DeviceRow[]>(web, "devices.list", undefined, "query");
  const desktop = rows.find((row) => row.client === "desktop");
  expect(desktop).toBeTruthy();
  await trpcCall(web, "devices.revoke", { id: desktop!.id }, "mutation");

  // Deleting a session sweeps the live sockets at once (auth.ts calls
  // revokeStaleSockets; the minute-long re-check is the fallback) and closes
  // this one with 4401. Only that close leads to this notice: onSessionRevoked
  // in use-sync.ts is the one caller of revokeThisDevice.
  await page.waitForURL(/\/login\//, { timeout: 90_000 });
  await expect(page.getByTestId("login-revoked")).toContainText("1 unsent change");
  const status = await page.evaluate(() => window.electronAPI!.secureStore.getToken());
  expect(status).toBeNull();
});

test("switching server signs out of the old one before the new one hears anything", async () => {
  const second = process.env.DESKTOP_E2E_SECOND_API;
  const secondLog = process.env.DESKTOP_E2E_SECOND_REQUEST_LOG;
  if (!second || !secondLog) throw new Error("the second API is not running");
  const { page, account, since } = await signedIn();
  const web = await webSession(account);

  // The picker lives on the login screen.
  await page.goto(`${APP_ORIGIN}/login/`);
  await page.getByTestId("server-picker-toggle").click();
  await page.getByTestId("server-picker-own").click();
  await page.getByTestId("server-picker-address").fill(second);
  const switchedAt = Date.now();
  await page.getByTestId("server-picker-save").click();

  // The switch reloads onto /login/, now pointed at the second server.
  await expect(page.getByTestId("server-picker-current")).toContainText(new URL(second).port, { timeout: 20_000 });
  await expect(page.getByTestId("login-email")).toBeVisible();

  const signOuts = appRequests(since).filter((r) => r.method === "POST" && r.url.startsWith("/api/auth/sign-out"));
  expect(signOuts).toHaveLength(1);
  expect(signOuts[0].authorization).toBe("Bearer");
  // The new server's health check (the picker's validation) comes first and
  // carries no credential; nothing that does may reach it before the sign-out.
  const credentialedOnNew = appRequests(switchedAt, secondLog).filter(
    (r) => r.method !== "OPTIONS" && (r.authorization !== null || r.url.startsWith("/api/trpc/") || r.kind === "upgrade"),
  );
  for (const request of credentialedOnNew) expect(request.at).toBeGreaterThanOrEqual(signOuts[0].at);
  const firstOnNew = appRequests(switchedAt, secondLog).filter((r) => r.method !== "OPTIONS");
  expect(firstOnNew.length).toBeGreaterThan(0);

  // The old server no longer lists the desktop app.
  const rows = await trpcCall<DeviceRow[]>(web, "devices.list", undefined, "query");
  expect(rows.filter((row) => row.client === "desktop")).toEqual([]);

  // And the app signs in to the new one, still without a cookie.
  const there = await createAccount(second);
  await signInThroughForm(page, there);
  await expect(page.getByTestId("tracker-toggle")).toBeVisible();
  await expect
    .poll(() => appRequests(switchedAt, secondLog).some((r) => r.url.startsWith("/api/trpc/") && r.authorization === "Bearer"))
    .toBe(true);
  expect(appRequests(switchedAt, secondLog).filter((r) => r.cookie)).toEqual([]);
});

test("OS idle reported by the main process raises the idle prompt", async () => {
  test.setTimeout(150_000);
  const { page, account } = await signedIn();
  const web = await webSession(account);
  await trpcCall(web, "settings.update", { idle: { enabled: true, thresholdMinutes: 1, behavior: "ask" } }, "mutation");
  await page.reload();
  await expect(page.getByTestId("tracker-toggle")).toBeVisible();

  // Started here, so this device owns the timer the idle rule applies to.
  await page.getByTestId("tracker-description").fill("Away from the desk");
  await page.getByTestId("tracker-toggle").click();
  await expect(page.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");

  // No idle span may begin before the entry did, and the shortest threshold
  // is a minute, so the timer has to have run for one. Moving its start back
  // from the web does not work: another device's edit is proof of life
  // (lib/idle-watcher.ts), which restarts the idle clock.
  await page.waitForTimeout(62_000);

  // The OS idle counter cannot be moved from a test; what it feeds can. This
  // is the payload idle.ts broadcasts, sent the way it sends it.
  await app!.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("idle:state", { state: "idle", idleSeconds: 61 });
    }
  });
  await page.waitForTimeout(300);
  await app!.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("idle:state", { state: "active", idleSeconds: 0 });
    }
  });
  await expect(page.getByTestId("idle-prompt")).toBeVisible({ timeout: 10_000 });
});
