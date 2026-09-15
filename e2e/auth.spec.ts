import { test, expect } from "@playwright/test";
import {
  signUpViaUI,
  signInViaUI,
  signOutViaUI,
  TRACK_URL,
  LOGIN_URL,
} from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

const TEST_USER = {
  name: "Test User",
  email: `test-${Date.now()}@example.com`,
  password: "SecurePassword123!",
};

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Authentication", () => {
  test("can sign up a new account", async ({ page }) => {
    await signUpViaUI(page, TEST_USER);
    await expect(page).toHaveURL(TRACK_URL);
  });

  test("can sign out", async ({ page }) => {
    await signInViaUI(page, TEST_USER);
    await signOutViaUI(page);
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test("can sign in with existing account", async ({ page }) => {
    await signInViaUI(page, TEST_USER);
    await expect(page).toHaveURL(TRACK_URL);
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-email").fill("nobody@example.com");
    await page.getByTestId("login-password").fill("WrongPassword123!");
    await page.getByTestId("login-submit").click();

    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("redirects to login when accessing protected page without auth", async ({
    page,
  }) => {
    // Clear cookies to ensure unauthenticated state
    await page.context().clearCookies();
    await page.goto("/app/track");
    await expect(page).toHaveURL(LOGIN_URL);
    // The requested page rides along, so signing in returns to it.
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toMatch(/^\/app\/track\/?$/);
  });

  test("forgot password page shows confirmation", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByTestId("forgot-email").fill(TEST_USER.email);

    // Assert the request itself, not just the banner. The banner appears
    // whatever the server answers — deliberately, so it cannot reveal whether
    // an address has an account — which means a wrong endpoint or a
    // redirectTo pointing at the API host both look like success here.
    const [request] = await Promise.all([
      page.waitForRequest((req) =>
        req.url().endsWith("/api/auth/request-password-reset"),
      ),
      page.getByTestId("forgot-submit").click(),
    ]);

    // better-auth resolves redirectTo against its OWN base URL, so a relative
    // path emails a link back to the API host, which serves no reset page.
    const body = JSON.parse(request.postData() ?? "{}") as {
      redirectTo?: string;
    };
    expect(new URL(body.redirectTo ?? "").origin).toBe(
      new URL(page.url()).origin,
    );
    expect(new URL(body.redirectTo ?? "").pathname).toBe("/reset-password");

    await expect(page.getByTestId("reset-sent")).toBeVisible();
  });
});
