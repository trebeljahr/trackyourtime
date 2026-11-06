#!/usr/bin/env node
/**
 * Captures the screenshots the GitHub README and the social preview cards use.
 *
 *   node scripts/marketing/capture-readme.mjs <web-origin> <email> <password> [out-dir]
 *
 * Run it against a local server seeded by seed-demo.mjs (docs/marketing/README.md
 * → "GitHub set" has the whole recipe). Desktop shots are 1600×1000 at device
 * scale 2, the phone shot is 390×844 at 3, all saved as JPEG (quality 88)
 * into docs/marketing/screenshots/ unless another directory is given.
 *
 * A fresh account shows its recovery key once; the script answers "I've saved
 * it" so the card does not cover the screens. The key belongs to a throwaway
 * local demo account.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [origin, email, password, outArg] = process.argv.slice(2);
if (!origin || !email || !password) {
  console.error("Usage: capture-readme.mjs <web-origin> <email> <password> [out-dir]");
  process.exit(1);
}
const outDir = resolve(outArg ?? "docs/marketing/screenshots");

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fourWeeksAgo = new Date(Date.now() - 27 * 86_400_000);
const reportsPath = `/app/reports/?group=task&from=${ymd(fourWeeksAgo)}&to=${ymd(new Date())}`;

const DESKTOP = { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/** `next dev` draws its own badge into the page; a capture must not ship it. */
const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";

async function signedInPage(browser, device, theme) {
  const context = await browser.newContext({ ...device, colorScheme: theme });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("trackyourtime.theme", value);
    } catch {}
  }, theme);
  const page = await context.newPage();
  await page.goto(`${origin}/login/`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/track\/?$/, { timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  const saved = page.getByRole("button", { name: "I've saved it" });
  if (await saved.count()) await saved.first().click();
  return { context, page };
}

async function capture(page, path, name, ready = "main") {
  await page.goto(`${origin}${path}`);
  await page.locator(ready).first().waitFor({ timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: HIDE_DEV_CHROME });
  // A pointer left over a chart opens a tooltip in the capture.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, `${name}.jpg`), type: "jpeg", quality: 88 });
  console.log(`captured ${name}`);
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  const light = await signedInPage(browser, DESKTOP, "light");
  await capture(light.page, "/app/track/", "web-track-light");
  await capture(light.page, reportsPath, "web-reports-light", '[data-testid="groupby-switch"]');
  await capture(light.page, "/app/calendar/", "web-calendar-light");
  await light.context.close();

  const phone = await signedInPage(browser, PHONE, "light");
  await capture(phone.page, "/app/track/", "phone-track-light");
  await phone.context.close();

  // The theme is a synced preference, so a local value alone is overwritten
  // by the account's. Pick it in the top bar the way a person would, and put
  // it back afterwards.
  const dark = await signedInPage(browser, DESKTOP, "dark");
  await dark.page.getByTestId("theme-toggle").click();
  await dark.page.getByTestId("theme-option-dark").click();
  await capture(dark.page, "/app/track/", "web-track-dark");
  await capture(dark.page, reportsPath, "web-reports-dark", '[data-testid="groupby-switch"]');
  await dark.page.getByTestId("theme-toggle").click();
  await dark.page.getByTestId("theme-option-light").click();
  await dark.context.close();
} finally {
  await browser.close();
}
