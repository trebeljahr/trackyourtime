// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleBackPress, ROOT_TAB } from "./back-button";
import { pushOverlay, resetOverlayStack } from "./overlay-stack";

afterEach(resetOverlayStack);

describe("handleBackPress", () => {
  it("closes the top overlay and consumes the press", () => {
    const dismiss = vi.fn();
    pushOverlay(dismiss);
    const navigate = vi.fn();

    expect(handleBackPress({ pathname: "/app/settings", navigate })).toBe(true);
    expect(dismiss).toHaveBeenCalledTimes(1);
    // An open dialog absorbs the press entirely — it must not also navigate.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("returns to the root tab from anywhere else", () => {
    const navigate = vi.fn();
    expect(
      handleBackPress({
        pathname: "/app/reports",
        navigate,
        dismissOverlay: () => false,
      }),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith(ROOT_TAB);
  });

  it("asks to exit at the root tab", () => {
    const navigate = vi.fn();
    expect(
      handleBackPress({
        pathname: ROOT_TAB,
        navigate,
        dismissOverlay: () => false,
      }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never reaches for the keyboard", () => {
    // The press contract is two presses with the IME up: Android spends the
    // first dismissing the keyboard and the WebView never hears about it. The
    // tempting "fix" is to import @capacitor/keyboard and hide the IME from
    // here so one press does both — which spends a press Android already
    // spent, and takes back away from the keyboard, the one thing every
    // Android user expects it to do first.
    //
    // A source assertion because there is nothing to observe: the correct
    // behaviour is a call that is never made, from a module that does not
    // import the plugin at all.
    // From cwd, not import.meta.url: under `@vitest-environment jsdom` that
    // is not a file: URL. Assert the read landed on the right file first —
    // a source scan of the wrong file passes for the wrong reason.
    const source = readFileSync(
      resolve(process.cwd(), "src/mobile/back-button.ts"),
      "utf8",
    );
    expect(source).toContain("export function handleBackPress");
    // Comments stripped, because the docstring names the plugin in order to
    // say why it is not used — and a scan that counted that would be a test
    // no one could ever explain the reasoning next to.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/@capacitor\/keyboard/);
    expect(code).not.toMatch(/\bKeyboard\b/);
  });

  it("treats a child of the root tab as the root", () => {
    // Nothing lives under /app/track today, but a future detail route must not
    // navigate to its own parent and then need a second press to exit.
    expect(
      handleBackPress({
        pathname: "/app/track/2026-09-07",
        navigate: () => undefined,
        dismissOverlay: () => false,
      }),
    ).toBe(false);
  });
});
