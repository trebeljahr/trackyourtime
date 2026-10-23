// Browser interaction checks, not a native desktop certification.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the browser library already installed by the repository's test runner.
const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve("@playwright/test"))("playwright");
const output = path.resolve(process.argv[2] ?? "test-results/desktop-shell-lab");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const results = [];
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => { errors.push(`Unexpected network request: ${route.request().url()}`); return route.abort(); });
  await page.goto(pathToFileURL(path.join(output, "index.html")).href);
  for (const profile of ["win32", "kde", "gnome", "ubuntu", "xfce", "darwin"]) {
    await page.selectOption("#platform", profile);
    await page.click("#reset");
    assert.equal(await page.locator("#background").isChecked(), profile === "win32");
    assert.equal(await page.locator("#tray-button").isVisible(), profile !== "gnome");
    await page.click("#login");
    assert.equal(await page.locator("#timer-window").isVisible(), profile !== "win32");
    await page.click("#launcher");
    await page.click("#close-window");
    assert.equal(await page.locator("#timer-window").isVisible(), false);
    await page.click("#launcher");
    assert.equal(await page.locator("#timer-window").isVisible(), true);
    if (profile !== "gnome") {
      await page.click("#show-menu");
      await page.getByRole("button", { name: "Stop timer", exact: true }).last().click();
      assert.equal(await page.locator("#state").inputValue(), "idle");
      await page.click("#show-menu");
      await page.getByRole("button", { name: "Design review — Website", exact: true }).click();
      assert.equal(await page.locator("#task").textContent(), "Design review");
      assert.equal(await page.locator("#state").inputValue(), "running");
      await page.check("#offline");
      await page.click("#show-menu");
      assert.equal(await page.locator("#native-menu").getByText("2 unsent changes", { exact: true }).count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#native-menu").isVisible(), false);
      await page.selectOption("#state", "signed-out");
      await page.click("#show-menu");
      assert.equal(await page.locator("#native-menu button").count(), 2);
      await page.keyboard.press("Escape");
    } else {
      assert.equal(await page.locator("#show-menu").isDisabled(), true);
      await page.click("#toggle-timer");
      assert.equal(await page.locator("#state").inputValue(), "idle");
      await page.getByRole("button", { name: "Design review Website", exact: true }).click();
      assert.equal(await page.locator("#state").inputValue(), "running");
    }
    await page.click("#reset");
    if (profile !== "gnome") await page.click("#show-menu");
    await page.screenshot({ path: path.join(output, `${profile}.png`), fullPage: true });
    results.push({ profile, result: "passed", scope: "browser simulation; shared app model" });
  }
  await page.selectOption("#platform", "kde");
  await page.check("#background");
  await page.click("#login");
  assert.equal(await page.locator("#timer-window").isVisible(), false);
  await page.uncheck("#tray");
  await page.click("#login");
  assert.equal(await page.locator("#timer-window").isVisible(), true);
  results.push({ check: "Linux opt-in and tray-disabled login recovery", result: "passed" });
  await page.selectOption("#platform", "win32");
  await page.click("#close-window");
  await page.click("#tray-button");
  assert.equal(await page.locator("#timer-window").isVisible(), true);
  await page.click("#tray-button", { button: "right" });
  assert.equal(await page.locator("#native-menu").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.click("#shortcut");
  assert.equal(await page.locator("#state").inputValue(), "idle");
  results.push({ check: "Windows left/right activation and simulated shortcut", result: "passed" });
  for (const width of [375, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `responsive-${width}.png`), fullPage: true });
    results.push({ check: `No page overflow at ${width}px`, result: "passed" });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await writeFile(path.join(output, "verification.json"), JSON.stringify({ results, errors, nativeOSValidation: false }, null, 2) + "\n");
}
console.log(`${results.length} browser checks passed; no native OS claims.`);
