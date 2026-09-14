import { test, expect } from "@playwright/test";
import { signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

/**
 * The web app at phone width.
 *
 * This runs in the `phone` Playwright project (playwright.config.ts) — a
 * 393pt chromium viewport against the same servers every other spec uses.
 * It is NOT a test of the native app, which no browser can run. It is the
 * guard on the claim that makes the native work safe: every rule in
 * packages/client/src/styles/native.css is scoped under `html.cap`, a class
 * only the Capacitor shell ever sets, so a narrow browser window is
 * untouched by all of it.
 *
 * That claim is easy to break by accident — one rule written as
 * `@media (max-width: 640px)` instead of `html.cap`, and the web app silently
 * inherits the phone treatment. So most of the assertions below are
 * deliberately about the ABSENCE of native chrome, not the presence of it.
 *
 * The exception is the last block. styles/standalone.css deliberately is NOT
 * inert by construction — it matches `@media (display-mode: standalone)` in a
 * plain browser, because an installed PWA gets `viewport-fit=cover` from the
 * same static export and none of native.css. Those rules are checked in both
 * directions: absent in a browser tab, present once the display mode is
 * emulated.
 */

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
    // The premise. Everything else in this file follows from it.
    //
    // Both elements, because the marker moved: on <body> it meant a pre-paint
    // script mutating body, which meant `suppressHydrationWarning` on <body>,
    // which silenced every body-level hydration mismatch the web app might
    // ever have. That half cannot be asserted from here — the prop never
    // reaches the DOM — so it lives in src/app/pre-paint.test.ts.
    await expect(page.locator("html")).not.toHaveClass(/\bcap\b/);
    await expect(page.locator("body")).not.toHaveClass(/\bcap\b/);
    expect(await page.locator("html").getAttribute("data-platform")).toBeNull();
    expect(await page.locator("body").getAttribute("data-platform")).toBeNull();
  });

  test("gets the drawer, not native chrome", async ({ page }) => {
    // The web app's own narrow-screen affordance is the hamburger + drawer,
    // and it still is one: the native tab bar is behind the same `html.cap`
    // gate as everything else.
    const toggle = page.getByTestId("sidebar-toggle");
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId("sidebar-mobile")).toBeVisible();
    await page.getByTestId("sidebar-close").click();
    await expect(page.getByTestId("sidebar-mobile")).toHaveCount(0);
  });

  test("renders the tab bar into the DOM but never shows it", async ({
    page,
  }) => {
    // Both halves matter, and they are the reason the bar is CSS-gated
    // rather than gated on `isNative()`.
    //
    // Present: under `output: "export"` the markup is prerendered in Node,
    // where `window.Capacitor` cannot exist. A component that returns null
    // unless native therefore ships in the HTML on web and disappears at
    // hydration on the phone — a mismatch React resolves by discarding the
    // served DOM. So it must be here, in every build.
    //
    // Invisible: and it must cost the web app nothing at 393pt, which is
    // exactly the width where a bottom bar would do the most damage.
    const bar = page.getByTestId("mobile-tab-bar");
    await expect(bar).toHaveCount(1);
    await expect(bar).toBeHidden();
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).toBe(
      "none",
    );
  });

  test("keeps the web page bottom padding — no tab bar to clear", async ({
    page,
  }) => {
    // native.css pads app-main by the bar's height plus the home indicator.
    // On web the padding has to stay the layout's own `py-4`.
    const main = page.getByTestId("app-main");
    const padding = await main.evaluate(
      (el) => getComputedStyle(el).paddingBottom,
    );
    expect(padding).toBe("16px");

    const offset = await page.evaluate(() =>
      getComputedStyle(document.body)
        .getPropertyValue("--app-tab-bar-offset")
        .trim(),
    );
    expect(offset).toBe("");
  });

  test("keeps the web input size — no 16px override", async ({ page }) => {
    // native.css forces 16px on every native field so iOS does not zoom on
    // focus. On web the design's own `text-sm` has to survive.
    //
    // Measured on the manual-entry date field, which is a bare `Input` at
    // `text-sm`. NOT on the tracker composer's description: that one carries
    // an explicit `text-base`, so it is 16px on web too and would pass this
    // assertion whether or not the native rule leaked.
    await page.getByTestId("tracker-manual-open").click();
    const field = page.getByTestId("manual-entry-date");
    await expect(field).toBeVisible();

    const size = await field.evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("14px");
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
    // `h-14` and nothing added on top of it.
    expect(box.height).toBe("56px");
    expect(box.paddingTop).toBe("0px");
  });

  test("keeps the web tracker composer flex basis", async ({ page }) => {
    // native.css gives the description `flex-basis: 100%` under `html.cap`,
    // so it takes the whole first line and the controls wrap under it. On web
    // the `basis-64` utility (16rem) has to be what applies.
    //
    // Asserted on the computed flex-basis rather than on rendered widths: at
    // 393pt the description happens to fill the row under BOTH rules, so a
    // width comparison would pass with the native rule leaking.
    // The flex item is the field wrapper around the combobox input.
    const description = page.getByTestId("tracker-description-field");
    await expect(description).toBeVisible();

    const basis = await description.evaluate(
      (el) => getComputedStyle(el).flexBasis,
    );
    expect(basis).toBe("256px");
  });

  test("keeps dialogs centred — no top anchoring", async ({ page }) => {
    await page.getByTestId("tracker-manual-open").click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    // `top-[50%]` untouched: native.css moves it to
    // `calc(env(safe-area-inset-top) + 1rem)` — 16px in a browser, which has
    // no insets — only under `html.cap`. getComputedStyle resolves `top` to a
    // used value in px, so the percentage is compared as one.
    const { top, half } = await dialog.evaluate((el) => ({
      top: parseFloat(getComputedStyle(el).top),
      half: window.innerHeight / 2,
    }));
    expect(top).toBeCloseTo(half, 0);
  });

  test("the entries list still starts where the web layout puts it", async ({
    page,
  }) => {
    // STICKY_TOP in entry-list.tsx now reads `var(--app-header-offset, 3.5rem)`.
    // The variable is set only by native.css, so on web it must be unset and
    // the fallback must be what applies.
    const offset = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--app-header-offset").trim(),
    );
    expect(offset).toBe("");
  });

  test("keeps popovers on their own collision padding", async ({ page }) => {
    // The popover half of the dialog rule above. A Radix popover is placed by
    // Floating UI against the LAYOUT viewport, which under `viewport-fit=cover`
    // starts at the physical top of the screen — so on a phone a panel with
    // nowhere to go is shifted under the Dynamic Island. CSS cannot move it
    // back (the popper wrapper's `transform` is inline and computed from those
    // measurements), so ui/popover.tsx widens `collisionPadding` by the insets
    // that native.css publishes.
    //
    // On web there are no such properties to read, so the widening must not
    // happen at all — and the size bound native.css puts on the panel must not
    // apply either.
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
    expect(style.maxHeight).toBe("none");
    expect(style.maxWidth).toBe("none");
  });

  test("the manual-entry date field ends where its siblings do", async ({
    page,
  }) => {
    // WebKit refuses author `box-sizing` on a date input while the native
    // control's appearance is in force, so `width: 100%` plus `px-3` and a
    // border became a used width 26px wider than the column: measured on iOS
    // 26 at 402pt, the field ran 25px past the dialog padding and 5px off the
    // screen. globals.css opts the whole date/time family out of that
    // appearance, which is the only thing that restores border-box sizing —
    // `box-sizing: border-box !important`, `max-width: 100%` and `min-width:
    // 0` were each measured on the device and each changed nothing.
    //
    // Chromium never had the bug, so the box assertions here are a bound, not
    // a reproduction: what fails in this browser when the rule goes is the
    // `appearance` assertion, which is the fix itself.
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

    // Inside the dialog's padding box, inside the screen, and flush with the
    // text field above it — the three things it was not on iOS.
    expect(geometry.date).toBeLessThanOrEqual(geometry.inner + 0.5);
    expect(geometry.date).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.date).toBeCloseTo(geometry.sibling, 0);
  });
});

test.describe("the installed PWA at phone width", () => {
  /*
   * The one part of the mobile work that is NOT gated on a class Capacitor
   * sets. `viewport-fit=cover` lives in the static `viewport` export, and one
   * static export serves the browser, the installed PWA and both native
   * shells — so an installed PWA gets real insets with none of native.css
   * applying to it, and content runs under the notch.
   * `styles/standalone.css` is the `@media (display-mode: standalone)` copy of
   * the safe-area geometry that fixes that.
   *
   * WHAT THIS CAN AND CANNOT ASSERT. Not the layout: Chromium cannot be put
   * into standalone display mode from a test. `Emulation.setEmulatedMedia`
   * ignores a `display-mode` feature (measured — `matchMedia` still answers
   * `browser` afterwards), DevTools exposes no such override, and a
   * `--app=<url>` window does not come back as a Playwright page. So the
   * geometry is asserted where it can be: in the browser tab, where every one
   * of these rules must be inert, and against the SHIPPED stylesheet, which
   * is read out of `document.styleSheets` in the real browser rather than
   * grepped off disk — so a deleted file, a dropped `@import`, or a build that
   * strips the block all fail here.
   */
  test.beforeEach(async ({ page }) => {
    await signUpViaUI(page, {
      name: "Phone PWA",
      email: uniqueEmail("pwa"),
      password: PASSWORD,
    });
  });

  test("is a browser tab here, so none of the rules apply", async ({ page }) => {
    // The premise for the rest of the file. Every "web keeps its layout"
    // assertion above would also pass if standalone.css simply did not exist,
    // so this pins WHY they pass: the gate is closed, not missing.
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

    // The header, the sticky tracker bar under it, the bottom of the page,
    // the drawer and the dialog — the five places a notch or a home indicator
    // can eat content.
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

    // Every one of them behind `html:not(.cap)`. Without it these stack with
    // native.css inside an Android WebView that reports standalone, and the
    // two disagree about exactly one value — see the next assertion.
    for (const rule of block) {
      expect(rule.selector).toContain(":not(.cap)");
    }

    // That value: the native app clears a 3.5rem tab bar plus the home
    // indicator, the PWA clears the home indicator alone. Copying the native
    // rule wholesale would leave a 56px dead strip under every page in the
    // installed app.
    const main = block.find((rule) => rule.selector.includes("app-main"));
    expect(main?.text).toContain("safe-area-inset-bottom");
    expect(main?.text).not.toContain("--app-tab-bar-offset");
  });
});
