import type { ThemePreference } from "@starter/core";
import { useSyncExternalStore } from "react";

/** Local extension theme. Read synchronously before the popup first paints. */

const STORAGE_KEY = "trackyourtime.theme";

const isTheme = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

const prefersDark = (): boolean =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** The saved extension theme, or the system setting by default. */
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
    /* Keep the current popup themed even if storage is unavailable. */
  }
  applyTheme(theme);
  window.dispatchEvent(new Event("trackyourtime:theme-change"));
};

export const useTheme = (): ThemePreference =>
  useSyncExternalStore(
    (onChange) => {
      window.addEventListener("trackyourtime:theme-change", onChange);
      return () => window.removeEventListener("trackyourtime:theme-change", onChange);
    },
    cachedTheme,
    () => "system",
  );
