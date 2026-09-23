/*
 * Headless mode for tests and agents: the app runs, loads and answers IPC, but
 * no window is ever shown or focused and, on macOS, no Dock icon appears and
 * the app never activates. Every launch in a test run otherwise steals
 * keyboard focus from whoever is using the machine and flashes a window
 * across the screen.
 *
 * Chromium keeps painting a hidden window (`paintWhenInitiallyHidden` is on by
 * default), but reading a frame back OUT of one is a per-platform question.
 * On macOS the window keeps a compositor surface whatever its ordering, so
 * Playwright screenshots and `capturePage()` work. On X11 an unmapped window
 * has no surface to copy from: the capture is queued, never answered, and the
 * caller hangs. That is why scripts/desktop-linux-smoke.mjs runs the window
 * SHOWN under Xvfb rather than headless, and why the paint assertion in
 * e2e/desktop/shell.spec.ts does not run on Linux.
 */

export const HEADLESS_ENV = "TRACKYOURTIME_HEADLESS";

export function isHeadless(env: Record<string, string | undefined> = process.env): boolean {
  return env[HEADLESS_ENV] === "1";
}
