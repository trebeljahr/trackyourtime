import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { MongoClient, ObjectId } from "mongodb";

import {
  appRequests,
  answerDeviceCode,
  createAccount,
  enableTwoFactor,
  launchApp,
  stubOpenExternal,
  trpcCall,
  webSession,
  type Account,
} from "./support";

/*
 * Stage 3 of docs/desktop-app-plan.md: "Sign in with your browser".
 *
 * The approving browser is the harness's web session for the same account
 * (support.ts): it claims and approves the code exactly as /app/device does.
 * shell.openExternal is stubbed, so no real browser ever opens.
 */

let app: ElectronApplication | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

type DeviceRow = { id: string; name: string; client: string };

async function atLogin(): Promise<{ page: Page; opened: () => Promise<string[]>; since: number }> {
  const since = Date.now();
  const launched = await launchApp();
  app = launched.app;
  const opened = await stubOpenExternal(launched.app);
  await launched.page.waitForURL(/\/login\//);
  await launched.page.getByTestId("browser-sign-in").waitFor();
  return { page: launched.page, opened, since };
}

async function codeShown(page: Page): Promise<string> {
  await page.getByTestId("browser-sign-in").click();
  const code = (await page.getByTestId("browser-sign-in-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/\S{4,}/);
  return code;
}

async function signsInThroughBrowser(account: Account, approver: string): Promise<void> {
  const { page, opened, since } = await atLogin();
  const code = await codeShown(page);
  await expect.poll(opened).toEqual([expect.stringContaining(`user_code=${encodeURIComponent(code)}`)]);

  await answerDeviceCode(approver, code, "approve");
  await page.waitForURL(/^app:\/\/-\/app\/track\//, { timeout: 20_000 });
  await expect(page.getByTestId("tracker-toggle")).toBeVisible();

  const rows = await trpcCall<DeviceRow[]>(approver, "devices.list", undefined, "query");
  const desktop = rows.filter((row) => row.client === "desktop");
  expect(desktop).toHaveLength(1);
  expect(desktop[0].name).toContain("Desktop app");

  await expect
    .poll(() => appRequests(since).some((r) => r.url.startsWith("/api/trpc/") && r.authorization === "Bearer"))
    .toBe(true);
  const fromApp = appRequests(since);
  expect(fromApp.filter((r) => r.url.startsWith("/api/auth/device/token")).length).toBeGreaterThan(0);
  expect(fromApp.filter((r) => r.cookie)).toEqual([]);
}

test("an account with two-factor on signs in through the browser", async () => {
  const account = await createAccount();
  const approver = await enableTwoFactor(account, await webSession(account));

  // The password form cannot finish the challenge in the app, and says what can.
  const { page } = await atLogin();
  await page.getByTestId("login-email").fill(account.email);
  await page.getByTestId("login-password").fill(account.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toContainText("Sign in with your browser");
  await app!.close();
  app = null;

  await signsInThroughBrowser(account, approver);
});

test("an account with no password, as a Google-only account has, signs in through the browser", async () => {
  const account = await createAccount();
  const approver = await webSession(account);

  // Remove the password: what is left is an account only another sign-in
  // method can reach. (Google itself cannot run against a local API.)
  const uri = process.env.DESKTOP_E2E_MONGODB_URI;
  if (!uri) throw new Error("DESKTOP_E2E_MONGODB_URI is not set");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const user = await db.collection("user").findOne({ email: account.email });
    if (!user) throw new Error("user row not found");
    const id = user._id as ObjectId;
    const removed = await db
      .collection("account")
      .deleteMany({ providerId: "credential", $or: [{ userId: id }, { userId: id.toString() }] });
    expect(removed.deletedCount).toBe(1);
  } finally {
    await client.close();
  }

  await signsInThroughBrowser(account, approver);
});

test("declining in the browser returns the app to the form with a message", async () => {
  const account = await createAccount();
  const approver = await webSession(account);
  const { page } = await atLogin();
  const code = await codeShown(page);

  await answerDeviceCode(approver, code, "deny");
  await expect(page.getByTestId("browser-sign-in-error")).toContainText("declined in the browser", { timeout: 20_000 });
  await expect(page.getByTestId("browser-sign-in")).toBeEnabled();
  await expect(page.getByTestId("login-email")).toBeVisible();
  expect(page.url()).toMatch(/\/login\//);
  expect(await page.evaluate(() => window.electronAPI!.secureStore.getToken())).toBeNull();
});
