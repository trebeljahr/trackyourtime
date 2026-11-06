import { test, expect } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { closeDbConnection } from "./db-utils";

// "Browser sign-in delivers the keys" (docs/private-workspace-protocol.md):
// a client without its own way to open the keys (Raycast, the extension, the
// desktop app) signs in through the browser and receives the account keys,
// sealed, through the same approval. Here the client is core's own helper,
// run in the test process, against the real API and web app.

const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;
const PASSWORD = "Browser-Keys-123!";

test.afterAll(async () => {
  await closeDbConnection();
});

const options = { baseUrl: API, clientId: "trackyourtime-raycast" as const };
// Loaded dynamically, like `passwordForApi` in helpers.ts: a static import of
// core's sources beside that dynamic one breaks the second spec in a worker.
const core = () => import("../packages/core/src/index");
type Transfer = { userId: string; keys: { publicKey: { x: string }; signingPublicKey: { x: string } }; secrets: { master: string } };

async function identityOf(page: import("@playwright/test").Page) {
  return page.evaluate(async (api) => {
    const response = await fetch(`${api}/api/trpc/privacy.identity?input=${encodeURIComponent("{}")}`, { credentials: "include" });
    return (await response.json()).result?.data?.identity ?? null;
  }, API);
}

test.describe("Browser sign-in delivers the keys", () => {
  test("one approval signs the client in and hands it the account keys", async ({ page }) => {
    const email = `browser-keys-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Keys", email, password: PASSWORD });
    await expect(page.getByTestId("tracker-bar")).toBeVisible({ timeout: 20_000 });
    const identity = await identityOf(page);
    expect(identity?.publicKey?.x).toBeTruthy();

    const { pollForDeviceSession, startBrowserSignIn } = await core();
    const flow = await startBrowserSignIn<Transfer>(options);
    const url = new URL(flow.url);
    expect(url.hash.startsWith("#keys=")).toBe(true);
    // The request never reaches a server: only the path and code do.
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(url.pathname + url.search + url.hash);
    await expect(page.getByTestId("device-code-input")).toHaveValue(flow.userCode);
    // Moved into this tab's storage and off the address bar.
    expect(new URL(page.url()).hash).toBe("");
    await page.getByTestId("device-approve").click();
    await expect(page.getByTestId("device-result-keys")).toHaveAttribute("role", "status", { timeout: 20_000 });
    expect(requests.filter((sent) => sent.includes(flow.request.secret))).toEqual([]);

    const session = await pollForDeviceSession(options, flow.deviceCode, { intervalSeconds: 1, timeoutSeconds: 30 });
    const { userId, keys } = await flow.collectKeys(session.token, { intervalMs: 300 });
    expect(keys?.userId).toBe(userId);
    expect(keys?.keys.publicKey.x).toBe(identity.publicKey.x);
    expect(keys?.keys.signingPublicKey.x).toBe(identity.signingPublicKey.x);
    expect(typeof keys?.secrets.master).toBe("string");
  });

  test("the request survives a sign-in on the way, in the same tab", async ({ page, browser }) => {
    const email = `browser-keys-login-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Keys", email, password: PASSWORD });
    await expect(page.getByTestId("tracker-bar")).toBeVisible({ timeout: 20_000 });

    const { pollForDeviceSession, startBrowserSignIn } = await core();
    const flow = await startBrowserSignIn<Transfer>(options);
    const url = new URL(flow.url);
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await fresh.goto(url.pathname + url.search + url.hash);
    await fresh.waitForURL(/\/login/, { timeout: 10_000 });
    expect(new URL(fresh.url()).toString()).not.toContain(flow.request.secret);
    await fresh.getByTestId("login-email").fill(email);
    await fresh.getByTestId("login-password").fill(PASSWORD);
    await fresh.getByTestId("login-submit").click();
    await expect(fresh.getByTestId("device-code-input")).toHaveValue(flow.userCode, { timeout: 20_000 });
    await fresh.getByTestId("device-approve").click();
    await expect(fresh.getByTestId("device-result-keys")).toHaveAttribute("role", "status", { timeout: 20_000 });

    const session = await pollForDeviceSession(options, flow.deviceCode, { intervalSeconds: 1, timeoutSeconds: 30 });
    const { keys } = await flow.collectKeys(session.token, { intervalMs: 300 });
    expect(keys?.keys.publicKey.x).toBeTruthy();
    await context.close();
  });

  test("a plain device code without a key request signs in and sends no keys", async ({ page }) => {
    const email = `browser-nokeys-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Keys", email, password: PASSWORD });
    const { pollForDeviceSession, startBrowserSignIn } = await core();
    const flow = await startBrowserSignIn(options);
    const url = new URL(flow.url);
    await page.goto(url.pathname + url.search); // an older client: no fragment
    await page.getByTestId("device-approve").click();
    await expect(page.getByTestId("device-approval-result")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("device-result-keys")).toHaveCount(0);
    const session = await pollForDeviceSession(options, flow.deviceCode, { intervalSeconds: 1, timeoutSeconds: 30 });
    expect(await flow.collectKeys(session.token)).toMatchObject({ keys: null });
  });
});
