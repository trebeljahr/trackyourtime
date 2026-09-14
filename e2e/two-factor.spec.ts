import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { LOGIN_URL, TRACK_URL, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";
const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

/** RFC 6238 over a base32 key — what an authenticator app computes. */
function totp(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Sign out from Settings → Account, which is on screen already. */
async function signOut(page: Page): Promise<void> {
  await page.goto("/settings?tab=account");
  await page.getByTestId("account-sign-out").click();
  await page.waitForURL(LOGIN_URL, { timeout: 10_000 });
}

async function submitPassword(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
}

test.describe("Two-factor authentication", () => {
  test("enrol, then sign in with a TOTP code and with a single-use backup code", async ({ page, request }) => {
    const email = `two-factor-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Two Factor", email, password: PASSWORD });

    // Enrol from Settings → Account.
    await page.goto("/settings?tab=account");
    await page.getByTestId("two-factor-enable").click();
    await page.getByTestId("two-factor-password").fill(PASSWORD);
    await page.getByTestId("two-factor-password-submit").click();
    await expect(page.getByTestId("two-factor-qr")).toBeVisible();
    const secret = (await page.getByTestId("two-factor-secret").textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    await page.getByTestId("two-factor-verify-code").fill(totp(secret));
    await page.getByTestId("two-factor-verify-submit").click();
    const codesList = page.getByTestId("two-factor-backup-codes");
    await expect(codesList).toBeVisible();
    const backupCodes = await codesList.locator("li").allTextContents();
    expect(backupCodes).toHaveLength(10);
    await page.getByTestId("two-factor-codes-done").click();
    await expect(page.getByTestId("two-factor-disable")).toBeVisible();

    await signOut(page);

    // A password alone: the second step, no navigation.
    await submitPassword(page, email);
    await expect(page.getByTestId("login-two-factor")).toBeVisible();
    await expect(page).toHaveURL(LOGIN_URL);

    await page.getByTestId("two-factor-code").fill(totp(secret));
    await page.getByTestId("two-factor-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });

    await signOut(page);

    // A backup code works once.
    const [backup] = backupCodes;
    await submitPassword(page, email);
    await page.getByTestId("two-factor-switch").click();
    await page.getByTestId("two-factor-code").fill(backup);
    await page.getByTestId("two-factor-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });

    await signOut(page);

    await submitPassword(page, email);
    await page.getByTestId("two-factor-switch").click();
    await page.getByTestId("two-factor-code").fill(backup);
    await page.getByTestId("two-factor-submit").click();
    await expect(page.getByTestId("two-factor-error")).toContainText("already been used");
    await expect(page).toHaveURL(LOGIN_URL);

    // A token client (the extension's signInWithPassword) gets no token.
    const response = await request.post(`${API}/api/auth/sign-in/email`, {
      data: { email, password: PASSWORD },
      headers: { "x-tracktime-client": "tracktime-extension", origin: `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? "49762"}` },
    });
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect(response.headers()["set-auth-token"]).toBeUndefined();
  });

  test("the Google button is disabled when the server has no Google client", async ({ page }) => {
    await page.goto("/login");
    const wrapper = page.getByTestId("google-sign-in");
    await expect(wrapper).toHaveAttribute("data-availability", "unconfigured");
    await expect(page.getByTestId("google-sign-in-button")).toBeDisabled();
  });
});
