#!/usr/bin/env node
/**
 * Captures the web app screens the marketing pages and store listings use.
 *
 *   node scripts/marketing/capture-web.mjs <web-origin> <email> <password> <out-dir> [light|dark]
 *
 * Run it against a local static build seeded by seed-demo.mjs. 1440x900 at
 * 2x, so a capture stays sharp when a page scales it down.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [origin, email, password, outDir, theme = "light"] = process.argv.slice(2);
if (!origin || !email || !password || !outDir) {
  console.error("Usage: capture-web.mjs <web-origin> <email> <password> <out-dir> [light|dark]");
  process.exit(1);
}

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fourWeeksAgo = new Date(Date.now() - 27 * 86_400_000);

const SCREENS = [
  { name: "web-track", path: "/app/track/", ready: "main" },
  // Grouped by task across four weeks: the one view the landing page argues for.
  {
    name: "web-reports",
    path: `/app/reports/?group=task&from=${ymd(fourWeeksAgo)}&to=${ymd(new Date())}`,
    ready: '[data-testid="groupby-switch"]',
  },
  { name: "web-timesheet", path: "/app/timesheet/", ready: "main" },
  { name: "web-calendar", path: "/app/calendar/", ready: "main" },
  { name: "web-invoices", path: "/app/invoices/", ready: '[data-testid="invoices-table"]' },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: theme,
});
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

for (const screen of SCREENS) {
  await page.goto(`${origin}${screen.path}`);
  await page.locator(screen.ready).first().waitFor({ timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  // `next dev` draws its own badge into the page; a capture of a dev server
  // must not ship it.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  // A pointer left over a chart opens a tooltip in the capture.
  await page.mouse.move(0, 899);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, `${screen.name}.png`) });
  console.log(`captured ${screen.name}`);
}

// The invoice itself, opened from the list.
await page.goto(`${origin}/invoices/`);
await page.locator('[data-testid^="invoice-open-"]').first().click();
await page.getByTestId("invoice-detail").waitFor();
await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
await page.waitForTimeout(800);
await page.screenshot({ path: join(outDir, "web-invoice.png") });
console.log("captured web-invoice");

await browser.close();
