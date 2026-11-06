import { test, expect, type Page, type Request } from "@playwright/test";
import { passwordForApi, signInViaUI, signUpViaUI } from "./helpers";
import { closeDbConnection, getDb } from "./db-utils";

// Password unlock (docs/private-workspace-protocol.md → "Password unlock"):
// every account gets keys without a question, the typed password never leaves
// the browser, and a new device opens the account with the password alone.

const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;
const PASSWORD = "Unlock-Password-123!";
const NEW_PASSWORD = "Reset-Password-456!";
const CLIENT = `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? "49762"}`;

/** Sign up, read the recovery key from its card and confirm it was saved. */
async function signUpAndSaveRecoveryKey(page: Page, email: string): Promise<string> {
  await signUpViaUI(page, { name: "Recovery", email, password: PASSWORD });
  await expectTrackerWithoutGate(page);
  const value = page.getByTestId("recovery-key-value");
  await expect(value).toBeVisible({ timeout: 20_000 });
  const recoveryKey = (await value.textContent())!.trim();
  expect(recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByTestId("recovery-key-saved").click();
  await expect(page.getByTestId("private-keys-notice")).toBeHidden();
  return recoveryKey;
}

/** Reset the password through the emailed link's page, in a fresh browser. */
async function resetPassword(browser: import("@playwright/test").Browser, request: import("@playwright/test").APIRequestContext, email: string) {
  const asked = await request.post(`${API}/api/auth/request-password-reset`, { data: { email, redirectTo: `${CLIENT}/reset-password` } });
  expect(asked.ok()).toBe(true);
  const db = await getDb();
  const user = await db.collection("user").findOne({ email });
  const row = await db.collection("verification").findOne({ value: String(user!._id ?? user!.id), identifier: { $regex: "^reset-password:" } }, { sort: { createdAt: -1 } })
    ?? await db.collection("verification").findOne({ identifier: { $regex: "^reset-password:" } }, { sort: { createdAt: -1 } });
  const token = String(row!.identifier).slice("reset-password:".length);
  const context = await browser.newContext();
  const page = await context.newPage();
  const bodies = recordBodies(page);
  await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
  await page.getByTestId("reset-new-password").fill(NEW_PASSWORD);
  await page.getByTestId("reset-confirm-password").fill(NEW_PASSWORD);
  await page.getByTestId("reset-submit").click();
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  expect(bodies.filter((body) => body.includes(NEW_PASSWORD))).toEqual([]);
  await context.close();
}

test.afterAll(async () => {
  await closeDbConnection();
});

/** Every request body the page sends to the API, for a "never sent" check. */
function recordBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (request: Request) => {
    if (request.url().startsWith(API)) bodies.push(`${request.url()}\n${request.postData() ?? ""}`);
  });
  return bodies;
}

async function expectTrackerWithoutGate(page: Page) {
  await expect(page.getByTestId("tracker-bar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("private-workspace-locked")).toBeHidden();
}

test.describe("Password unlock", () => {
  test("a new account gets keys silently, stays unlocked across a reload and opens on a new device", async ({ page, browser }) => {
    const email = `unlock-${Date.now()}@example.com`;
    const bodies = recordBodies(page);
    await signUpViaUI(page, { name: "Unlock", email, password: PASSWORD });
    await expectTrackerWithoutGate(page);
    expect(bodies.some((body) => body.includes("/api/auth/sign-up/email"))).toBe(true);
    expect(bodies.filter((body) => body.includes(PASSWORD))).toEqual([]);

    // Keys were created: the account's identity carries a password envelope.
    const identity = await page.evaluate(async (api) => {
      const response = await fetch(`${api}/api/trpc/privacy.identity?input=${encodeURIComponent("{}")}`, { credentials: "include" });
      return (await response.json()).result?.data?.identity ?? null;
    }, API);
    expect(identity?.password?.kdf?.kdf).toBe("PBKDF2-SHA256");

    await page.reload();
    await expectTrackerWithoutGate(page);

    const other = await browser.newContext();
    const device = await other.newPage();
    const deviceBodies = recordBodies(device);
    await signInViaUI(device, { email, password: PASSWORD });
    await expectTrackerWithoutGate(device);
    expect(deviceBodies.filter((body) => body.includes(PASSWORD))).toEqual([]);
    await other.close();
  });

  test("an account from before password unlock upgrades at its next sign-in", async ({ page, request }) => {
    const email = `legacy-${Date.now()}@example.com`;
    const created = await request.post(`${API}/api/auth/sign-up/email`, {
      data: { name: "Legacy", email, password: PASSWORD },
      headers: { origin: `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? "49762"}` },
    });
    expect(created.ok()).toBe(true);
    expect(await passwordForApi(API, email, PASSWORD)).toBe(PASSWORD);

    await signInViaUI(page, { email, password: PASSWORD });
    await expectTrackerWithoutGate(page);

    const derived = await passwordForApi(API, email, PASSWORD);
    expect(derived).not.toBe(PASSWORD);
    const typed = await request.post(`${API}/api/auth/sign-in/email`, { data: { email, password: PASSWORD } });
    expect(typed.ok()).toBe(false);
    const secret = await request.post(`${API}/api/auth/sign-in/email`, { data: { email, password: derived } });
    expect(secret.ok()).toBe(true);
  });

  test("after a reset, a new device opens the keys with the recovery key and seals them under the new password", async ({ page, browser, request }) => {
    const email = `recover-${Date.now()}@example.com`;
    const recoveryKey = await signUpAndSaveRecoveryKey(page, email);
    await page.reload();
    await expectTrackerWithoutGate(page);
    await expect(page.getByTestId("private-keys-notice")).toBeHidden();

    await resetPassword(browser, request, email);

    const second = await browser.newContext();
    const device = await second.newPage();
    await signInViaUI(device, { email, password: NEW_PASSWORD });
    await expect(device.getByTestId("recover-keys")).toBeVisible({ timeout: 20_000 });
    await device.getByTestId("recover-keys-input").fill(recoveryKey);
    await device.getByRole("button", { name: "Open with recovery key" }).click();
    await expect(device.getByTestId("private-keys-notice")).toBeHidden({ timeout: 20_000 });
    await expectTrackerWithoutGate(device);
    await second.close();

    // The keys now open with the new password alone.
    const third = await browser.newContext();
    const another = await third.newPage();
    await signInViaUI(another, { email, password: NEW_PASSWORD });
    await expectTrackerWithoutGate(another);
    await expect(another.getByTestId("private-keys-notice")).toBeHidden();
    await third.close();
  });

  test("a device that stayed unlocked updates the keys after a reset made elsewhere", async ({ page, browser, request }) => {
    const email = `stale-${Date.now()}@example.com`;
    await signUpAndSaveRecoveryKey(page, email);
    await resetPassword(browser, request, email);

    await page.reload();
    await expectTrackerWithoutGate(page);
    const notice = page.getByTestId("update-keys-after-reset");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("update-keys-password").fill(PASSWORD);
    await notice.getByRole("button", { name: "Update keys" }).click();
    await expect(notice.getByRole("alert")).toBeVisible();
    await page.getByTestId("update-keys-password").fill(NEW_PASSWORD);
    await notice.getByRole("button", { name: "Update keys" }).click();
    await expect(page.getByTestId("private-keys-notice")).toBeHidden({ timeout: 20_000 });

    const other = await browser.newContext();
    const device = await other.newPage();
    await signInViaUI(device, { email, password: NEW_PASSWORD });
    await expectTrackerWithoutGate(device);
    await expect(device.getByTestId("private-keys-notice")).toBeHidden();
    await other.close();
  });

  test("Settings creates a new recovery key while the keys are open", async ({ page }) => {
    const email = `new-recovery-${Date.now()}@example.com`;
    const first = await signUpAndSaveRecoveryKey(page, email);
    await page.goto("/app/settings?tab=account");
    const button = page.getByTestId("new-recovery-key");
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const value = page.getByTestId("recovery-key-value").first();
    await expect(value).toBeVisible({ timeout: 20_000 });
    const second = (await value.textContent())!.trim();
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });
});
