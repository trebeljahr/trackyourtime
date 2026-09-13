import { test, expect } from "@playwright/test";
import { logManualEntry, signUpViaUI, LOGIN_URL } from "./helpers";
import { cleanDatabase, closeDbConnection, getDb } from "./db-utils";

const PASSWORD = "SecurePassword123!";
const API = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? "49761"}`;

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

/** Everything left in the database that still points at `userId`. */
async function leftovers(userId: string, email: string): Promise<Record<string, number>> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  const oid = new ObjectId(userId);
  const counts: Record<string, number> = {
    user: await db.collection("user").countDocuments({ _id: oid }),
    session: await db.collection("session").countDocuments({ userId: oid }),
    account: await db.collection("account").countDocuments({ userId: oid }),
    member: await db.collection("member").countDocuments({ userId: oid }),
    workspacemembers: await db.collection("workspacemembers").countDocuments({ userId }),
    timeentries: await db.collection("timeentries").countDocuments({ authorId: userId }),
    userpreferences: await db.collection("userpreferences").countDocuments({ userId }),
    byEmail: await db.collection("user").countDocuments({ email }),
  };
  return counts;
}

test.describe("Account deletion", () => {
  test("deletes the account from Settings, with the password, and signs out", async ({ page }) => {
    const email = `delete-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Delete Me", email, password: PASSWORD });
    await logManualEntry(page, "Work that will be deleted", "1:00:00");

    const db = await getDb();
    const user = await db.collection("user").findOne({ email });
    expect(user).not.toBeNull();
    const userId = String(user?._id);
    expect((await leftovers(userId, email)).timeentries).toBe(1);

    await page.goto("/settings?tab=account");
    await page.getByTestId("delete-account").click();

    const dialog = page.getByTestId("delete-account-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("delete-account-scope")).toContainText(
      "In workspaces only you use, everything is deleted",
    );
    await expect(page.getByTestId("delete-account-confirm")).toBeDisabled();

    await page.getByTestId("delete-account-password").fill("not the password");
    await page.getByTestId("delete-account-confirm").click();
    await expect(page.getByTestId("delete-account-error")).toContainText(
      "That password is not correct",
    );
    expect((await leftovers(userId, email)).user).toBe(1);

    await page.getByTestId("delete-account-password").fill(PASSWORD);
    await page.getByTestId("delete-account-confirm").click();
    await page.waitForURL(LOGIN_URL, { timeout: 10_000 });

    expect(await leftovers(userId, email)).toEqual({
      user: 0,
      session: 0,
      account: 0,
      member: 0,
      workspacemembers: 0,
      timeentries: 0,
      userpreferences: 0,
      byEmail: 0,
    });

    // And the credentials are gone with it.
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("works with a bearer token and no cookie, and requires the password", async ({
    page,
    playwright,
  }) => {
    const email = `delete-bearer-${Date.now()}@example.com`;
    await signUpViaUI(page, { name: "Phone User", email, password: PASSWORD });

    // A client with no cookie jar at all — what the mobile shells are.
    const api = await playwright.request.newContext({ baseURL: API });
    const signIn = await api.post("/api/auth/sign-in/email", {
      data: { email, password: PASSWORD },
      headers: { "x-tracktime-client": "tracktime-mobile" },
    });
    expect(signIn.ok()).toBe(true);
    const token = signIn.headers()["set-auth-token"];
    expect(token).toBeTruthy();
    await api.dispose();

    const bare = await playwright.request.newContext({ baseURL: API });
    const headers = { authorization: `Bearer ${token}` };

    const noPassword = await bare.post("/api/auth/delete-user", { data: {}, headers });
    expect(noPassword.status()).toBe(400);
    expect((await noPassword.json()).code).toBe("PASSWORD_REQUIRED");

    const deleted = await bare.post("/api/auth/delete-user", {
      data: { password: PASSWORD },
      headers,
    });
    expect(deleted.status()).toBe(200);

    const session = await bare.get("/api/auth/get-session", { headers });
    expect(await session.json()).toBeNull();
    await bare.dispose();

    // The browser's own session died with the account too.
    await page.goto("/track");
    await page.waitForURL(LOGIN_URL, { timeout: 10_000 });
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });
});
