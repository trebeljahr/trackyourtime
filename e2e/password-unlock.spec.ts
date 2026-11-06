import { test, expect, type Page, type Request } from "@playwright/test";
import { passwordForApi, signInViaUI, signUpViaUI } from "./helpers";
import { closeDbConnection } from "./db-utils";

// Password unlock (docs/private-workspace-protocol.md → "Password unlock"):
// every account gets keys without a question, the typed password never leaves
// the browser, and a new device opens the account with the password alone.

const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;
const PASSWORD = "Unlock-Password-123!";

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
});
