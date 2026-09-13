#!/usr/bin/env node
/**
 * Captures the browser extension's popup, signed in to a local server.
 *
 *   node scripts/marketing/capture-extension.mjs <api-origin> <email> <password> <out-dir> [light|dark]
 *
 * Loads the dev build (`pnpm run build:extension`) unpacked. Its origin must
 * be in the local server's TRUSTED_ORIGINS — `pnpm run extension:id dev`
 * prints it — or sign-in answers 403 INVALID_ORIGIN.
 */
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [apiOrigin, email, password, outDir, theme = "light"] = process.argv.slice(2);
if (!apiOrigin || !email || !password || !outDir) {
  console.error("Usage: capture-extension.mjs <api-origin> <email> <password> <out-dir> [light|dark]");
  process.exit(1);
}

const extensionPath = resolve("packages/extension/dist");
await mkdir(outDir, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "tt-ext-")), {
  channel: "chromium",
  headless: true,
  colorScheme: theme,
  viewport: { width: 380, height: 600 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent("serviceworker");
const extensionId = new URL(worker.url()).host;
const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;

const page = await context.newPage();
await page.goto(popupUrl);
await page.getByTestId("sign-in-screen").waitFor();

const apiInput = page.getByTestId("api-url-input");
if (!(await apiInput.isVisible())) {
  await page.getByText(/server|api url/i).first().click();
}
await apiInput.fill(apiOrigin);
await page.getByTestId("api-url-save").click();
await page.waitForTimeout(500);

await page.getByTestId("sign-in-email").fill(email);
await page.getByTestId("sign-in-password").fill(password);
await page.getByTestId("sign-in-submit").click();
await page.getByTestId("sign-in-screen").waitFor({ state: "detached", timeout: 15_000 });
await page.waitForTimeout(2000);

const shoot = async (name) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });
  console.log(`captured ${name}`);
};

// The running timer, with nothing focused.
await page.locator("body").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Escape");
await shoot("popup-running");

// Description autocomplete, mid-word. Escape twice afterwards: the first
// closes the list, the second reverts the text, so the blur does not rename
// the running entry.
const description = page.locator('input[aria-autocomplete], input[role="combobox"]').first();
await description.click();
await description.fill("review");
await page.waitForTimeout(1500);
await shoot("popup-autocomplete");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// Today's entries.
await page.getByTestId("header-entries").click();
await page.getByTestId("entries-screen").waitFor();
await page.waitForTimeout(1200);
await shoot("popup-entries");

console.log(`extension id ${extensionId}`);
await context.close();
