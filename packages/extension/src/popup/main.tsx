import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadPopupSnapshot } from "../lib/popup-snapshot";
import { applyTheme, cachedTheme } from "./theme";
import { resolveExtensionLocale } from "../i18n";
import "./popup.css";
if (import.meta.env.VITE_ERROR_REPORTING_ENABLED) {
  void import("../lib/error-reporting").then(({ startErrorReporting }) => startErrorReporting("popup"));
}

const reportPopupError = (error: unknown): void => {
  if (import.meta.env.VITE_ERROR_REPORTING_ENABLED) {
    void import("../lib/error-reporting").then(({ reportExtensionError }) => reportExtensionError(error, "popup"));
  }
};

// Before the first render, and synchronously: the popup is rebuilt from
// scratch every time it is opened, so a theme applied after the worker answers
// would flash the wrong one several times a day. `App` corrects this the
// moment a snapshot carrying the real preference arrives.
applyTheme(cachedTheme());
// The language too, from the same kind of synchronous mirror: `<html lang>`
// decides hyphenation and what a screen reader pronounces from the first frame.
document.documentElement.lang = resolveExtensionLocale();

const container = document.getElementById("root");
if (!container) {
  throw new Error("popup root element is missing from index.html");
}

// Read the memory-only cache before mounting: an effect always paints the
// loading screen first, even when the previous timer is already available.
void loadPopupSnapshot().then((initialState) => {
  createRoot(container, { onUncaughtError: reportPopupError, onCaughtError: reportPopupError }).render(
    <StrictMode>
      <App initialState={initialState} />
    </StrictMode>,
  );
});
