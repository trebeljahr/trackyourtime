import { test, expect, type Page } from "@playwright/test";
import { signUpViaUI, TRACK_URL } from "./helpers";

/**
 * The smoke flow, in German, against the static export.
 *
 * Every page outside /de/ is prerendered in English, so a German reader's
 * first paint is the risky part: the locale must switch AFTER hydration
 * (a German render during hydration is a text mismatch React reports and
 * then repairs by discarding the served DOM) while the pre-paint gate hides
 * the English frame. So besides "the words are German", this spec pins that a
 * reload stays German and that no hydration error reaches the console.
 */

const PASSWORD = "SecurePassword123!";

/** React's hydration failures, spelled out in dev and minified in production. */
const HYDRATION_ERROR =
  /hydrat|did not match|Minified React error #(418|419|422|423|425)\b/i;

let sequence = 0;
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** Collects every console error and uncaught page error from here on. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectGermanShell(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByTestId("nav-track")).toContainText("Erfassen");
  await expect(page.getByTestId("nav-settings")).toContainText("Einstellungen");
}

test.describe("German (de)", () => {
  test("the app is German end to end once the picker says so", async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await signUpViaUI(page, {
      name: "Deutsch Nutzer",
      email: uniqueEmail("i18n-de"),
      password: PASSWORD,
    });

    // ── pick German in Settings ─────────────────────────────────────
    await page.goto("/app/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("setting-language")).toContainText("Language");

    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("settings.update") && response.ok(),
    );
    await page.getByTestId("language-de").click();
    await saved;

    await expect(page.getByTestId("language-de")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("setting-language")).toContainText("Sprache");
    await expect(page.getByTestId("settings-tab-general")).toHaveText("Allgemein");
    await expectGermanShell(page);
    expect(
      await page.evaluate(() => window.localStorage.getItem("trackyourtime.locale")),
    ).toBe("de");

    // ── start and stop a timer ──────────────────────────────────────
    await page.getByTestId("nav-track").click();
    await page.waitForURL(TRACK_URL);
    await expect(page.getByTestId("entries-empty")).toContainText(
      "Noch keine Zeit erfasst",
    );
    await expect(page.getByTestId("tracker-toggle")).toHaveText("Starten");

    await page.getByTestId("tracker-description").fill("Angebot schreiben");
    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(page.getByTestId("tracker-toggle")).toHaveText("Stoppen");

    await page.getByTestId("tracker-toggle").click();
    await expect(page.getByTestId("tracker-toggle")).toHaveAttribute(
      "data-state",
      "idle",
    );

    const row = page
      .locator('[data-testid="entry-row"]')
      .filter({ hasText: "Angebot schreiben" });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-running", "false");
    await expect(page.getByTestId("day-label").first()).toHaveText("Heute");
    await expect(page.getByTestId("day-count").first()).toHaveText("1 Eintrag");

    // ── reload keeps German, with no English frame hydrating as German ──
    await expect
      .poll(async () => (await row.getAttribute("data-entry-id")) ?? "")
      .not.toMatch(/^temp-/);
    await page.reload();
    await expect(page.getByTestId("tracker-toggle")).toHaveText("Starten");
    await expect(page.getByTestId("day-count").first()).toHaveText("1 Eintrag");
    await expectGermanShell(page);

    // ── reports ─────────────────────────────────────────────────────
    await page.getByTestId("nav-reports").click();
    await expect(page.getByTestId("summary-report")).toBeVisible();
    await expect(page.getByTestId("reports-screen")).toContainText("Berichte");
    await expect(page.getByTestId("report-view-totals")).toHaveText("Summen");
    await expect(page.getByTestId("report-view-entries")).toHaveText("Einträge");
    await expect(page.getByTestId("summary-report")).toContainText(
      "Gesamt erfasst",
    );

    // ── settings, straight from a cold load ─────────────────────────
    await page.goto("/app/settings");
    await expect(page.getByTestId("settings-tab-general")).toHaveText("Allgemein");
    await expect(page.getByTestId("settings-tab-account")).toHaveText("Konto");
    await expectGermanShell(page);

    // ── the preference lives on the account, not only in this browser ──
    await page.evaluate(() => window.localStorage.removeItem("trackyourtime.locale"));
    await page.reload();
    await expect(page.getByTestId("settings-tab-general")).toHaveText("Allgemein");
    await expect(page.getByTestId("language-de")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const hydrationErrors = errors.filter((text) => HYDRATION_ERROR.test(text));
    expect(hydrationErrors, hydrationErrors.join("\n")).toEqual([]);
  });

  test("/de/ is the German landing page with hreflang alternates", async ({
    page,
  }) => {
    const errors = collectErrors(page);

    const response = await page.goto("/de/");
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId("marketing-title")).toContainText(
      "Open-Source-Zeiterfassung auf jedem Gerät, das du nutzt",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    // The served <html> cannot carry lang="de" (one root layout for every
    // route); the content wrapper does, for crawlers that skip scripts.
    await expect(page.locator('[lang="de"]').first()).toBeAttached();

    const alternates = page.locator('head link[rel="alternate"][hreflang]');
    expect(await alternates.count()).toBeGreaterThanOrEqual(3);
    const hreflangs = await alternates.evaluateAll((links) =>
      Object.fromEntries(
        links.map((link) => [
          link.getAttribute("hreflang"),
          new URL(link.getAttribute("href") ?? "", window.location.href).pathname,
        ]),
      ),
    );
    expect(hreflangs).toMatchObject({
      en: "/",
      de: "/de/",
      "x-default": "/",
    });

    await expect(page.getByTestId("language-switch-en")).toHaveAttribute(
      "hreflang",
      "en",
    );

    const hydrationErrors = errors.filter((text) => HYDRATION_ERROR.test(text));
    expect(hydrationErrors, hydrationErrors.join("\n")).toEqual([]);
  });
});
