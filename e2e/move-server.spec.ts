import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import { test, expect, type Page } from "@playwright/test";
import { logManualEntry, signOutViaUI, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

/**
 * Settings → Data → Move to another server, between two real servers.
 *
 * The suite's own server (the one the web build talks to) is the source. A
 * second server is started here, on its own port and its own database, as the
 * target — the "self-hosted" one. It trusts the web build's origin, which is
 * what lets the browser copy directly; the file route is exercised by making
 * the target's health check say it does not.
 */

const PASSWORD = "SecurePassword123!";
const CLIENT_PORT = process.env.E2E_CLIENT_PORT ?? "49762";
const TARGET_PORT = process.env.E2E_TARGET_SERVER_PORT ?? "49764";
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const SOURCE_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/trackyourtime-e2e";

/** The source database's URI with `-move-target` on the database name. */
const targetUri = (): string => {
  const url = new URL(SOURCE_URI);
  url.pathname = `${url.pathname.replace(/\/$/, "") || "/trackyourtime-e2e"}-move-target`;
  return url.toString();
};

let target: ChildProcess | null = null;

const waitForHealth = async (origin: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${origin} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const dropTargetDatabase = async (): Promise<void> => {
  const client = new MongoClient(targetUri());
  await client.connect();
  await client.db().dropDatabase();
  await client.close();
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await cleanDatabase();
  await dropTargetDatabase();

  target = spawn(
    "pnpm",
    ["--filter", "@starter/server", "exec", "tsx", "src/index.ts"],
    {
      // Its own process group, so teardown stops the tsx child too — and only
      // the processes this spec started.
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: TARGET_PORT,
        MONGODB_URI: targetUri(),
        REDIS_URL: "",
        BETTER_AUTH_SECRET: "e2e-move-target-secret",
        BETTER_AUTH_URL: TARGET,
        FRONTEND_URL: TARGET,
        // The web build under test, so the browser may copy directly.
        TRUSTED_ORIGINS: `http://127.0.0.1:${CLIENT_PORT}`,
      },
    },
  );
  await waitForHealth(TARGET, 90_000);
});

test.afterAll(async () => {
  if (target?.pid) {
    try {
      process.kill(-target.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  target = null;
  await dropTargetDatabase().catch(() => undefined);
  await closeDbConnection();
});

let sequence = 0;
const uniqueEmail = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
};

/** How many finished entries the target holds for an account, asked over HTTP. */
const targetEntries = async (email: string): Promise<number> => {
  const signIn = await fetch(`${TARGET}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const token = signIn.headers.get("set-auth-token");
  expect(token, "the target should issue a session token").toBeTruthy();
  const info = await fetch(
    `${TARGET}/api/trpc/data.exportInfo?input=${encodeURIComponent("{}")}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await info.json()) as { result: { data: { entries: number } } };
  return body.result.data.entries;
};

const trackTwoEntries = async (page: Page, prefix: string): Promise<string> => {
  const email = uniqueEmail(prefix);
  await signUpViaUI(page, { name: "Mover", email, password: PASSWORD });
  await page.goto("/track");
  await expect(page.getByTestId("entries-empty")).toBeVisible();
  await logManualEntry(page, "Design review", "1:00:00");
  await logManualEntry(page, "Invoicing", "0:30:00");
  return email;
};

const openMoveDialog = async (page: Page): Promise<void> => {
  await page.goto("/settings?tab=data");
  await expect(page.getByTestId("settings-panel-data")).toBeVisible();
  await page.getByTestId("move-server-open").click();
  await expect(page.getByTestId("move-server-dialog")).toBeVisible();
};

const chooseTarget = async (page: Page): Promise<void> => {
  await page.getByTestId("move-target-own").check();
  await page.getByTestId("move-target-address").fill(TARGET);
  await page.getByTestId("move-target-check").click();
};

test.describe("Move to another server", () => {
  test("copies a workspace to another server directly, and a second run adds nothing", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const email = await trackTwoEntries(page, "move-direct");

    await openMoveDialog(page);

    // Refused before anything is asked of the network.
    await page.getByTestId("move-target-own").check();
    await page.getByTestId("move-target-address").fill("http://track.example.com");
    await page.getByTestId("move-target-check").click();
    await expect(page.getByTestId("move-error")).toContainText(
      "Use https:// for track.example.com",
    );

    await chooseTarget(page);
    await expect(page.getByTestId("move-server-found")).toContainText(
      "Found Track Your Time",
    );

    // No account on the target yet: create one inside the flow.
    await page.getByTestId("move-account-toggle").click();
    await page.getByTestId("move-account-name").fill("Mover");
    await page.getByTestId("move-account-email").fill(email);
    await page.getByTestId("move-account-password").fill(PASSWORD);
    await page.getByTestId("move-account-submit").click();

    await expect(page.getByTestId("move-ready-count")).toContainText(
      "2 finished entries will be copied",
    );
    await page.getByTestId("move-copy").click();

    await expect(page.getByTestId("move-done")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("move-done-complete")).toContainText(
      "All 2 entries are on",
    );
    await expect(page.getByTestId("move-done-entries")).toHaveText("2");
    await expect(page.getByTestId("move-done-skipped")).toHaveText("0");
    await expect(page.getByTestId("move-done-settings")).toHaveText("Restored");

    // The target really holds them — asked of the target itself.
    expect(await targetEntries(email)).toBe(2);

    // Nothing on the source was touched.
    await page.getByRole("button", { name: "Done" }).click();
    await page.goto("/track");
    await expect(page.locator('[data-testid="entry-row"]')).toHaveCount(2);

    // Moving again is safe: both entries are recognised as already there.
    await openMoveDialog(page);
    await chooseTarget(page);
    await page.getByTestId("move-account-email").fill(email);
    await page.getByTestId("move-account-password").fill(PASSWORD);
    await page.getByTestId("move-account-submit").click();
    await expect(page.getByTestId("move-ready-target-busy")).toContainText(
      "already has 2 entries",
    );
    await page.getByTestId("move-copy").click();
    await expect(page.getByTestId("move-done-complete")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("move-done-entries")).toHaveText("0");
    await expect(page.getByTestId("move-done-skipped")).toHaveText("2");
    expect(await targetEntries(email)).toBe(2);
  });

  test("moves through a file when the target does not trust this page", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await trackTwoEntries(page, "move-file");

    // The target, as a server that has not listed this web app's origin.
    await page.route(`${TARGET}/api/health`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...body, originTrusted: false },
      });
    });

    await openMoveDialog(page);
    await chooseTarget(page);
    await expect(page.getByTestId("move-file")).toContainText(
      "does not accept requests from this page's address",
    );

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("move-file-download").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^trackyourtime-move-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.getByTestId("move-file-saved")).toHaveText("Saved 1 file.");
    const file = await download.path();
    const doc = JSON.parse(await readFile(file, "utf8")) as { entries: unknown[] };
    expect(doc.entries).toHaveLength(2);

    // The other half, as it happens on the target's own web app: a fresh
    // account imports the file under Settings → Data.
    await page.getByRole("button", { name: "Done" }).click();
    await signOutViaUI(page);
    await signUpViaUI(page, {
      name: "Arrived",
      email: uniqueEmail("move-file-target"),
      password: PASSWORD,
    });
    await page.goto("/settings?tab=data");
    await page.getByTestId("import-file-input").setInputFiles(file);
    await expect(page.getByTestId("import-commit")).toContainText("Import 2 entries");
    // An empty workspace restores the file's settings by default.
    await expect(page.getByTestId("import-restore-settings")).toHaveAttribute(
      "data-state",
      "checked",
    );
    await page.getByTestId("import-commit").click();
    await expect(page.getByText("Imported 2 entries")).toBeVisible();

    await page.goto("/track");
    await expect(page.locator('[data-testid="entry-row"]')).toHaveCount(2);
  });
});
