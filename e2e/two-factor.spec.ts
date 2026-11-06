import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { LOGIN_URL, TRACK_URL, passwordForApi, waitForAppReady, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const PASSWORD = "SecurePassword123!";
const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

/** RFC 6238 over a base32 key at one time step — what an authenticator app computes. */
function totpAt(base32: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * A code the server has not seen yet. Each code verifies once
 * (auth/two-factor-guard.ts) and the server accepts the previous, current and
 * next step, so pick an unused one of those, or wait for the next step.
 */
async function freshTotp(base32: string, used: Set<number>): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    for (const step of [now + 1, now, now - 1]) {
      if (!used.has(step)) {
        used.add(step);
        return totpAt(base32, step);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Sign out from Settings → Account, which is on screen already. */
async function signOut(page: Page): Promise<void> {
  await page.goto("/app/settings?tab=account");
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
  test("enrol, sign in with a TOTP code and a single-use backup code, then make new codes and turn it off", async ({ page }) => {
    const email = `two-factor-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Two Factor", email, password: PASSWORD });

    // Enrol from Settings → Account.
    await page.goto("/app/settings?tab=account");
    await page.getByTestId("two-factor-enable").click();
    await page.getByTestId("two-factor-password").fill(PASSWORD);
    await page.getByTestId("two-factor-password-submit").click();
    await expect(page.getByTestId("two-factor-qr")).toBeVisible();
    const secret = (await page.getByTestId("two-factor-secret").textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    const used = new Set<number>();
    await page.getByTestId("two-factor-verify-code").fill(await freshTotp(secret, used));
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

    await page.getByTestId("two-factor-code").fill(await freshTotp(secret, used));
    await page.getByTestId("two-factor-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });
    await waitForAppReady(page);

    // That sign-in counts as a fresh second factor: an API token mints at once.
    await page.goto("/app/settings?tab=integrations");
    await page.getByTestId("create-api-token").click();
    await page.getByTestId("api-token-name-input").fill("Fresh after sign-in");
    await page.getByTestId("api-token-submit").click();
    await expect(page.getByTestId("api-token-reveal")).toBeVisible();
    await expect(page.getByTestId("api-token-step-up")).toHaveCount(0);

    await signOut(page);

    // A backup code works once.
    const [backup] = backupCodes;
    await submitPassword(page, email);
    await page.getByTestId("two-factor-switch").click();
    await page.getByTestId("two-factor-code").fill(backup);
    await page.getByTestId("two-factor-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });
    await waitForAppReady(page);

    await signOut(page);

    await submitPassword(page, email);
    await page.getByTestId("two-factor-switch").click();
    await page.getByTestId("two-factor-code").fill(backup);
    await page.getByTestId("two-factor-submit").click();
    await expect(page.getByTestId("two-factor-error")).toContainText("already been used");
    await expect(page).toHaveURL(LOGIN_URL);

    // New backup codes need the password and a code; the old ones stop working.
    await page.getByTestId("two-factor-switch").click();
    await page.getByTestId("two-factor-code").fill(await freshTotp(secret, used));
    await page.getByTestId("two-factor-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });
    await page.goto("/app/settings?tab=account");
    await page.getByTestId("two-factor-regenerate").click();
    await page.getByTestId("two-factor-regenerate-password").fill(PASSWORD);
    await page.getByTestId("two-factor-regenerate-code").fill(backupCodes[1]!);
    await page.getByTestId("two-factor-regenerate-submit").click();
    await expect(page.getByTestId("two-factor-backup-codes").locator("li")).toHaveCount(10);
    const fresh = await page.getByTestId("two-factor-backup-codes").locator("li").allTextContents();
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(backupCodes[2]);
    await page.getByTestId("two-factor-codes-done").click();

    // Turning it off needs a code too; a backup code from the new set works.
    await page.getByTestId("two-factor-disable").click();
    await page.getByTestId("two-factor-disable-password").fill(PASSWORD);
    await page.getByTestId("two-factor-disable-code").fill(backupCodes[2]!);
    await page.getByTestId("two-factor-disable-submit").click();
    await expect(page.getByRole("alert")).toContainText("not valid");
    await page.getByTestId("two-factor-disable-code").fill(fresh[0]!);
    await page.getByTestId("two-factor-disable-submit").click();
    await expect(page.getByTestId("two-factor-enable")).toBeVisible();

  });

  test("a client with no cookie jar completes the challenge through the header", async () => {
    // What the phone and desktop apps do: every request is a plain fetch with
    // no cookies, so the header is the only thing carrying the challenge.
    const email = `two-factor-native-${Date.now()}@example.com`;
    const json = { "content-type": "application/json", origin: `http://127.0.0.1:${process.env.E2E_CLIENT_PORT ?? "49762"}` };
    const up = await fetch(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, password: PASSWORD, name: "Native" }),
    });
    expect(up.ok).toBe(true);
    const bearer = { authorization: `Bearer ${up.headers.get("set-auth-token")}` };
    const enabled = await fetch(`${API}/api/auth/two-factor/enable`, {
      method: "POST",
      headers: { ...json, ...bearer },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret") ?? "";
    const used = new Set<number>();
    const confirmed = await fetch(`${API}/api/auth/two-factor/verify-totp`, {
      method: "POST",
      headers: { ...json, ...bearer },
      body: JSON.stringify({ code: await freshTotp(secret, used) }),
    });
    expect(confirmed.ok).toBe(true);

    const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { ...json, "x-trackyourtime-client": "trackyourtime-mobile" },
      body: JSON.stringify({ email, password: await passwordForApi(API, email, PASSWORD) }),
    });
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    expect(signIn.headers.get("set-auth-token")).toBeNull();
    const challenge = signIn.headers.get("set-two-factor-token");
    expect(challenge).toBeTruthy();
    expect(signIn.headers.get("access-control-expose-headers")).toContain("set-two-factor-token");

    const code = await freshTotp(secret, used);
    const verified = await fetch(`${API}/api/auth/two-factor/verify-totp`, {
      method: "POST",
      headers: { ...json, "x-two-factor-token": challenge!, "x-trackyourtime-client": "trackyourtime-mobile" },
      body: JSON.stringify({ code }),
    });
    expect(verified.status).toBe(200);
    const token = verified.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const session = await fetch(`${API}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email);

    // The same code again, on a new challenge: refused like a wrong code.
    const again = await fetch(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, password: await passwordForApi(API, email, PASSWORD) }),
    });
    const replay = await fetch(`${API}/api/auth/two-factor/verify-totp`, {
      method: "POST",
      headers: { ...json, "x-two-factor-token": again.headers.get("set-two-factor-token")! },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
  });

  test("the Google button is disabled when the server has no Google client", async ({ page }) => {
    await page.goto("/login");
    const wrapper = page.getByTestId("google-sign-in");
    await expect(wrapper).toHaveAttribute("data-availability", "unconfigured");
    await expect(page.getByTestId("google-sign-in-button")).toBeDisabled();
  });
});
