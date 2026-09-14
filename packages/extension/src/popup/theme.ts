import type { ThemePreference } from "@starter/core";

/**
 * The popup's copy of the account's theme.
 *
 * The preference itself is synced — it arrives on every {@link BackgroundState}
 * snapshot, so choosing dark in the web app darkens this popup too. What lives
 * here is only the local cache and the DOM plumbing, and the cache is what
 * makes it usable: the popup is destroyed on every close and rebuilt on every
 * open, so painting the light theme first and correcting it when the worker
 * answers would flash white in a dark browser several times a day.
 *
 * `localStorage` rather than `chrome.storage`, and that is the whole point —
 * it is synchronous, so the class is on `<html>` before React's first render.
 * The extension popup has its own origin, so nothing else can see it.
 */

const STORAGE_KEY = "trackyourtime.theme";

const isTheme = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

const prefersDark = (): boolean =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** The last theme this popup was told about, or "system" until it is told one. */
export const cachedTheme = (): ThemePreference => {
  try {
    const stored: unknown = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

/**
 * Write the resolved theme onto `<html>`.
 *
 * "system" is written as a concrete `light`/`dark` attribute rather than left
 * off, so the stylesheet needs one rule per theme instead of a media query
 * that has to be kept in step with the attribute selectors.
 */
export const applyTheme = (theme: ThemePreference): "light" | "dark" => {
  const resolved: "light" | "dark" =
    theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
};

/** Apply a theme and remember it for the next time the popup is opened. */
export const rememberTheme = (theme: ThemePreference): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* the popup just re-learns it from the next snapshot */
  }
  applyTheme(theme);
};
