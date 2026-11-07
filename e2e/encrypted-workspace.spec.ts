import { test, expect } from "@playwright/test";
import { signUpViaUI, TRACK_URL } from "./helpers";
import { closeDbConnection, getDb } from "./db-utils";

// Encrypted workspaces, early access (docs/private-workspace-protocol.md →
// "Creating an encrypted workspace"). The e2e server allows
// ENCRYPTED_WORKSPACE_USERS=@encrypted.example; nobody else sees the option.

const PASSWORD = "Encrypted-Space-123!";
const NAME = `Secret client ${Date.now()}`;

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("Encrypted workspace", () => {
  test("is created encrypted, shows its decrypted name, opens the tracker, and the server holds no plaintext name", async ({ page }) => {
    await signUpViaUI(page, { name: "Enc", email: `enc-${Date.now()}@encrypted.example`, password: PASSWORD });
    await page.getByTestId("recovery-key-saved").click({ timeout: 20_000 });

    const switcher = page.getByTestId("workspace-switcher");
    await switcher.click();
    await page.getByTestId("workspace-create").click();
    const dialog = page.getByTestId("new-workspace-dialog");
    await dialog.getByTestId("new-workspace-name").fill(NAME);
    await dialog.getByTestId("new-workspace-encrypted").locator("input").check();
    await dialog.getByTestId("new-workspace-submit").click();
    await page.waitForURL(TRACK_URL, { timeout: 20_000 });
    // The name comes from the encrypted record, not from the server.
    await expect(switcher).toContainText(NAME, { timeout: 20_000 });

    // The tracker opens in it, and the entry list reads from the encrypted copy.
    await expect(page.getByTestId("tracker-bar")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Could not load your entries")).toHaveCount(0);

    // Still there, still named, after a reload: the signed workspace list
    // lists it as encrypted and the name decrypts again.
    await page.reload();
    await expect(switcher).toContainText(NAME, { timeout: 20_000 });
    await expect(page.getByText("Could not load your entries")).toHaveCount(0);

    // Nothing the person typed reached the database in plaintext.
    const db = await getDb();
    for (const { name } of await db.listCollections().toArray()) {
      const rows = JSON.stringify(await db.collection(name).find({}).toArray());
      expect(rows.includes(NAME), `workspace name in ${name}`).toBe(false);
    }
  });

  test("is not offered to an account off the allowlist", async ({ page }) => {
    await signUpViaUI(page, { name: "Std", email: `std-${Date.now()}@example.com`, password: PASSWORD });
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-create").click();
    await expect(page.getByTestId("new-workspace-dialog")).toBeVisible();
    await expect(page.getByTestId("new-workspace-encrypted")).toHaveCount(0);
  });
});
