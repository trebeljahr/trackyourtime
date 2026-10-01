import { test, expect } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

/** Shared phone UX, with native platform identity kept separate from layout. */

const PASSWORD = "SecurePassword123!";

let sequence = 0;
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

test.beforeAll(async () => {
  await cleanDatabase();
});

test.afterAll(async () => {
  await closeDbConnection();
});

test.describe("web app at phone width", () => {
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Phone Layout",
      email: uniqueEmail("phone"),
      password: PASSWORD,
    });
  });

  test("is not treated as the native shell", async ({ page }) => {
    await expect(page.locator("html")).not.toHaveClass(/\bcap\b/);
    await expect(page.locator("body")).not.toHaveClass(/\bcap\b/);
    expect(await page.locator("html").getAttribute("data-platform")).toBeNull();
    expect(await page.locator("body").getAttribute("data-platform")).toBeNull();
  });

  test("keeps every destination reachable through the drawer", async ({ page }) => {
    const toggle = page.getByTestId("sidebar-toggle");
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId("sidebar-mobile")).toBeVisible();
    await page.getByTestId("sidebar-close").click();
    await expect(page.getByTestId("sidebar-mobile")).toHaveCount(0);
  });

  test("shows primary navigation within thumb reach", async ({
    page,
  }) => {
    const bar = page.getByTestId("mobile-tab-bar");
    await expect(bar).toHaveCount(1);
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).toBe(
      "flex",
    );
  });

  test("clears the bottom navigation", async ({
    page,
  }) => {
    const main = page.getByTestId("app-main");
    const padding = await main.evaluate(
      (el) => getComputedStyle(el).paddingBottom,
    );
    expect(parseFloat(padding)).toBeGreaterThanOrEqual(72);

    const offset = await page.evaluate(() =>
      getComputedStyle(document.body)
        .getPropertyValue("--app-tab-bar-offset")
        .trim(),
    );
    expect(offset).not.toBe("");
  });

  test("uses readable inputs without focus zoom", async ({ page }) => {
    await page.getByTestId("tracker-manual-open").click();
    const field = page.getByTestId("manual-entry-date");
    await expect(field).toBeVisible();

    const size = await field.evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("16px");
  });

  test("keeps the web header height — no safe-area padding", async ({
    page,
  }) => {
    const header = page.getByTestId("app-header");
    await expect(header).toBeVisible();

    const box = await header.evaluate((el) => {
      const style = getComputedStyle(el);
      return { height: style.height, paddingTop: style.paddingTop };
    });
    expect(box.height).toBe("56px");
    expect(box.paddingTop).toBe("0px");
  });

  test("gives the description its own row", async ({ page }) => {
    const description = page.getByTestId("tracker-description-field");
    await expect(description).toBeVisible();

    const basis = await description.evaluate(
      (el) => getComputedStyle(el).flexBasis,
    );
    expect(basis).toBe("100%");
  });

  test("keeps the dialog top reachable above the keyboard", async ({ page }) => {
    await page.getByTestId("tracker-manual-open").click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect(box?.y).toBeLessThan(24);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("the entries list still starts where the web layout puts it", async ({
    page,
  }) => {
    const offset = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--app-header-offset").trim(),
    );
    expect(offset).toBe("");
  });

  test("bounds popovers while retaining web collision padding", async ({ page }) => {
    const insets = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [
        "--app-safe-area-top",
        "--app-safe-area-right",
        "--app-safe-area-bottom",
        "--app-safe-area-left",
      ].map((name) => style.getPropertyValue(name).trim());
    });
    expect(insets).toEqual(["", "", "", ""]);

    await page.getByTestId("tracker-project").click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();

    const style = await popover.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { maxHeight: computed.maxHeight, maxWidth: computed.maxWidth };
    });
    expect(style.maxHeight).not.toBe("none");
    expect(style.maxWidth).not.toBe("none");
  });

  test("the manual-entry date field ends where its siblings do", async ({
    page,
  }) => {
    await page.getByTestId("tracker-manual-open").click();

    const field = page.getByTestId("manual-entry-date");
    await expect(field).toBeVisible();
    expect(await field.evaluate((el) => getComputedStyle(el).appearance)).toBe(
      "none",
    );

    const geometry = await page.evaluate(() => {
      const date = document.querySelector<HTMLElement>(
        '[data-testid="manual-entry-date"]',
      );
      const sibling = document.querySelector<HTMLElement>(
        '[data-testid="manual-entry-description"]',
      );
      const dialog = document.querySelector<HTMLElement>(
        '[data-slot="dialog-content"]',
      );
      if (!date || !sibling || !dialog) throw new Error("missing element");
      const box = dialog.getBoundingClientRect();
      return {
        date: date.getBoundingClientRect().right,
        sibling: sibling.getBoundingClientRect().right,
        inner: box.right - parseFloat(getComputedStyle(dialog).paddingRight),
        viewport: window.innerWidth,
      };
    });

    expect(geometry.date).toBeLessThanOrEqual(geometry.inner + 0.5);
    expect(geometry.date).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.date).toBeCloseTo(geometry.sibling, 0);
  });
});

test.describe("the installed PWA at phone width", () => {
  // Chromium cannot emulate installed display mode. Inspect the shipped safe-
  // area rules as well as the ordinary browser geometry above.
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Phone PWA",
      email: uniqueEmail("pwa"),
      password: PASSWORD,
    });
  });

  test("is a browser tab here, so none of the rules apply", async ({ page }) => {
    const mode = await page.evaluate(() => ({
      standalone: matchMedia("(display-mode: standalone)").matches,
      browser: matchMedia("(display-mode: browser)").matches,
    }));
    expect(mode).toEqual({ standalone: false, browser: true });
  });

  test("ships the safe-area block, scoped so it cannot reach the native app", async ({
    page,
  }) => {
    const block = await page.evaluate(() => {
      const found: { selector: string; text: string }[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRule[];
        try {
          rules = Array.from(sheet.cssRules);
        } catch {
          continue; // cross-origin sheet; the app has none
        }
        for (const rule of rules) {
          if (
            !(rule instanceof CSSMediaRule) ||
            !rule.conditionText.includes("display-mode: standalone")
          ) {
            continue;
          }
          for (const inner of Array.from(rule.cssRules)) {
            if (inner instanceof CSSStyleRule) {
              found.push({ selector: inner.selectorText, text: inner.cssText });
            }
          }
        }
      }
      return found;
    });

    const selectors = block.map((rule) => rule.selector).join(" | ");
    for (const target of [
      "[data-testid=\"app-header\"]",
      "[data-testid=\"tracker-bar\"]",
      "[data-testid=\"app-main\"]",
      "[data-testid=\"sidebar-mobile\"]",
      "[data-slot=\"dialog-content\"]",
    ]) {
      expect(selectors).toContain(target);
    }

    for (const rule of block) {
      expect(rule.selector).toContain(":not(.cap)");
    }

    const main = block.find((rule) => rule.selector.includes("app-main"));
    expect(main?.text).toContain("safe-area-inset-bottom");
    expect(main?.text).toContain("--app-tab-bar-offset");
  });
});
