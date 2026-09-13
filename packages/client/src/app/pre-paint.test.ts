// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { matchLocaleList } from "@starter/shared";

import { LOCALE_PENDING_ATTRIBUTE } from "@/i18n/config";
import { NATIVE_SHELL_SCRIPT, THEME_SCRIPT, localeScript } from "./pre-paint";

/*
 * The pre-paint marker, run for real.
 *
 * The defect this guards is not visual. The marker used to be written to
 * <body>, which made <body>'s attributes disagree with the served HTML at
 * hydration, which forced `suppressHydrationWarning` onto <body> — and that
 * attribute is not scoped to the one mismatch that needed it. It silences
 * every body-level mismatch the web app will ever have, forever, and nothing
 * about that is visible in a browser: React simply stops reporting.
 *
 * Which is also why the coverage is here and not in `e2e/mobile-shell.spec.ts`.
 * `suppressHydrationWarning` is a React-only prop, stripped before the HTML is
 * emitted, so no assertion against the served DOM can see it — an e2e test
 * that looked for the attribute would pass whether or not it was there
 * (measured: it did).
 */

function run(script: string): void {
  new Function(script)();
}

const nativeCapacitor = {
  isNativePlatform: () => true,
  getPlatform: () => "ios",
};

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-platform");
  document.body.className = "";
  document.body.removeAttribute("data-platform");
  Reflect.deleteProperty(window, "Capacitor");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("NATIVE_SHELL_SCRIPT", () => {
  it("marks <html> and leaves <body> alone", () => {
    Object.assign(window, { Capacitor: nativeCapacitor });
    run(NATIVE_SHELL_SCRIPT);

    expect(document.documentElement.classList.contains("cap")).toBe(true);
    expect(document.documentElement.getAttribute("data-platform")).toBe("ios");

    // The half that matters. A write here is what dragged
    // `suppressHydrationWarning` onto <body> in the first place.
    expect(document.body.classList.contains("cap")).toBe(false);
    expect(document.body.getAttribute("data-platform")).toBeNull();
  });

  it("does nothing at all in a browser", () => {
    run(NATIVE_SHELL_SCRIPT);
    expect(document.documentElement.className).toBe("");
    expect(document.documentElement.getAttribute("data-platform")).toBeNull();
  });

  it("does nothing when Capacitor is present but not native", () => {
    // The desktop shells and `ray develop` both load Capacitor-adjacent code
    // in a plain browser context.
    Object.assign(window, {
      Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
    });
    run(NATIVE_SHELL_SCRIPT);
    expect(document.documentElement.className).toBe("");
  });

  it("survives the theme script running after it", () => {
    // Both scripts write <html>'s className now, so their order has to stop
    // mattering. The theme script removes only "light" and "dark".
    Object.assign(window, {
      Capacitor: nativeCapacitor,
      // jsdom ships no matchMedia, and THEME_SCRIPT swallows its own errors —
      // without this the script would silently do nothing and the assertion
      // below would be checking that a no-op is harmless.
      matchMedia: () => ({ matches: true }),
    });
    run(NATIVE_SHELL_SCRIPT);
    run(THEME_SCRIPT);

    expect(document.documentElement.classList.contains("cap")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("LOCALE_SCRIPT", () => {
  const root = document.documentElement;

  const setLanguages = (languages: string[]): void => {
    Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
  };

  const at = (url: string): void => {
    window.history.replaceState(null, "", url);
  };

  afterEach(() => {
    root.removeAttribute("lang");
    root.removeAttribute("data-locale");
    root.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
    window.localStorage.clear();
    setLanguages(["en-US"]);
    at("/");
    vi.useRealTimers();
  });

  it("follows the device and holds the page for a German reader", () => {
    setLanguages(["de-DE", "en"]);
    run(localeScript(false));
    expect(root.lang).toBe("de");
    expect(root.getAttribute("data-locale")).toBe("de");
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(true);
  });

  it("never gates an English reader", () => {
    run(localeScript(false));
    expect(root.lang).toBe("en");
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
  });

  it("a stored choice beats the device", () => {
    setLanguages(["de-DE"]);
    window.localStorage.setItem("tracktime.locale", "en");
    run(localeScript(false));
    expect(root.lang).toBe("en");
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
  });

  it("agrees with the runtime resolver on every device language list", () => {
    // If the script and i18n/locale-store.ts ever disagree, the gate is lifted
    // on a page in the wrong language (or held for a switch that never comes).
    const lists = [["de"], ["de-CH"], ["fr-FR", "de-AT"], ["fr", "es"], ["EN_gb", "de"], [""], []];
    for (const languages of lists) {
      setLanguages(languages);
      root.removeAttribute("data-locale");
      run(localeScript(false));
      expect(root.getAttribute("data-locale"), languages.join(",")).toBe(matchLocaleList(languages));
    }
  });

  it("leaves the prerendered German pages alone", () => {
    at("/de/privacy/");
    run(localeScript(true));
    expect(root.lang).toBe("de");
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
  });

  it("lifts the gate on its own if the app never loads", () => {
    vi.useFakeTimers();
    setLanguages(["de"]);
    run(localeScript(false));
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
  });

  it("offers the pseudo-locale only in a build that allows it", () => {
    at("/track/?locale=pseudo");
    run(localeScript(false));
    expect(root.getAttribute("data-locale")).toBe("en");
    expect(localeScript(false)).not.toContain("pseudo");

    run(localeScript(true));
    expect(root.getAttribute("data-locale")).toBe("pseudo");
    expect(root.lang).toBe("en-XA");
  });

  it("writes only to <html>", () => {
    setLanguages(["de"]);
    const before = document.body.outerHTML;
    run(localeScript(true));
    expect(document.body.outerHTML).toBe(before);
  });
});

describe("app/layout.tsx", () => {
  const layout = readFileSync(join(__dirname, "layout.tsx"), "utf8");

  it("does not suppress hydration warnings on <body>", () => {
    // Asserted on the source because there is nowhere else to assert it: the
    // prop never reaches the DOM. If a future change needs it back, it needs
    // an argument in the diff, not a quiet re-add.
    const body = layout.slice(layout.indexOf("<body"), layout.indexOf("</body>"));
    expect(body).not.toContain("suppressHydrationWarning");
  });

  it("keeps the marker in <head>, ahead of the theme script", () => {
    // In <body> it could not mark <html> before <body> existed to be parsed,
    // and the ordering is what makes the layout jump-free on a WebView reload.
    const head = layout.slice(layout.indexOf("<head>"), layout.indexOf("</head>"));
    expect(head).toContain("NATIVE_SHELL_SCRIPT");
    expect(head.indexOf("NATIVE_SHELL_SCRIPT")).toBeLessThan(
      head.indexOf("THEME_SCRIPT"),
    );
  });

  it("inlines the locale script in <head> and gates the app inside <body>", () => {
    const head = layout.slice(layout.indexOf("<head>"), layout.indexOf("</head>"));
    expect(head).toContain("LOCALE_SCRIPT");
    const body = layout.slice(layout.indexOf("<body"), layout.indexOf("</body>"));
    expect(body).toContain("<LocaleRoot>");
  });
});
