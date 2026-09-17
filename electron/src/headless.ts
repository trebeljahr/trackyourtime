/*
 * Headless mode for tests and agents: the app runs, loads and answers IPC, but
 * no window is ever shown or focused and, on macOS, no Dock icon appears and
 * the app never activates. Every launch in a test run otherwise steals
 * keyboard focus from whoever is using the machine and flashes a window
 * across the screen.
 *
 * Chromium keeps painting a hidden window (`paintWhenInitiallyHidden` is on by
 * default), so Playwright screenshots and `capturePage()` still work.
 */

export const HEADLESS_ENV = "TRACKYOURTIME_HEADLESS";

export function isHeadless(env: Record<string, string | undefined> = process.env): boolean {
  return env[HEADLESS_ENV] === "1";
}
