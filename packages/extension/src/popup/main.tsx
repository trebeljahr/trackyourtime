import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, cachedTheme } from "./theme";
import { resolveExtensionLocale } from "../i18n";
import "./popup.css";

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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
