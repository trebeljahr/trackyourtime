import { test, expect } from "@playwright/test";
import { signUpViaUI, TRACK_URL } from "./helpers";

test.describe("Smoke tests", () => {
  test("landing page explains the product to a signed-out visitor", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("marketing-title")).toContainText(
      "Name the work once",
    );
    // The redirect runs once the session resolves. A signed-out visitor
    // must still be on the landing page after it has.
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/$/);
  });

  test("landing page sends a signed-in visitor to the tracker", async ({
    page,
  }) => {
    await signUpViaUI(page, {
      name: "Landing Redirect",
      email: `landing-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    });
    await page.goto("/");
    await page.waitForURL(TRACK_URL, { timeout: 10_000 });
  });

  for (const [path, title] of [
    ["/extension", "Chrome toolbar"],
    ["/raycast", "menu bar"],
    ["/mobile", "your phone"],
    ["/privacy", "Privacy policy"],
    ["/support", "Get help"],
  ] as const) {
    test(`public page ${path} loads`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId("marketing-title")).toContainText(title);
    });
  }

  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });

  test("signup page loads", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByText("Create an account")).toBeVisible();
  });

  test("health endpoint returns ok", async ({ request }) => {
    // Must track playwright.config.ts, which no longer defaults to 5006.
    const serverUrl =
      process.env.NEXT_PUBLIC_API_URL ??
      `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;
    const response = await request.get(`${serverUrl}/api/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });
});
