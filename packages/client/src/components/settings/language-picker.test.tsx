// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_OVERRIDE_STORAGE_KEY, LOCALE_STORAGE_KEY } from "@/i18n/config";
import {
  commitTargetLocale,
  getActiveLocale,
  resetLocaleStoreForTests,
  setLocaleSink,
} from "@/i18n/locale-store";

import { LanguagePicker } from "./language-picker";

/*
 * What these pin: the three choices are offered and the two languages name
 * themselves in their own language whatever the UI is in; a choice re-renders
 * the app at once, survives a reload (localStorage) and is published to the
 * server sink; and the pseudo-locale is a local switch that is never sent and
 * never offered unless asked for.
 */

const setNavigatorLanguages = (languages: string[]): void => {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
};

beforeEach(() => {
  window.localStorage.clear();
  setNavigatorLanguages(["en-US"]);
  resetLocaleStoreForTests();
  // What <LocaleRoot> does after hydration.
  act(() => commitTargetLocale());
});

afterEach(() => {
  cleanup();
  resetLocaleStoreForTests();
});

describe("LanguagePicker", () => {
  it("offers System, English and Deutsch, with System selected by default", () => {
    render(<LanguagePicker allowPseudo={false} />);
    expect(screen.getByTestId("language-system")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("language-en")).toHaveTextContent("English");
    expect(screen.getByTestId("language-de")).toHaveTextContent("Deutsch");
    expect(screen.queryByTestId("language-pseudo")).toBeNull();
  });

  it("switches the rendered language, stores the choice and sends it", () => {
    const sink = vi.fn();
    setLocaleSink(sink);
    render(<LanguagePicker allowPseudo={false} />);

    act(() => {
      fireEvent.click(screen.getByTestId("language-de"));
    });

    expect(getActiveLocale()).toBe("de");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    expect(sink).toHaveBeenCalledWith("de");
    // The picker itself is now German — except the language names.
    expect(screen.getByText("Sprache")).toBeInTheDocument();
    expect(screen.getByTestId("language-en")).toHaveTextContent("English");
    expect(screen.getByTestId("language-de")).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.lang).toBe("de");
  });

  it("System follows the device's languages", () => {
    setNavigatorLanguages(["fr-FR", "de-AT", "en"]);
    resetLocaleStoreForTests();
    act(() => commitTargetLocale());
    render(<LanguagePicker allowPseudo={false} />);
    expect(getActiveLocale()).toBe("de");
    expect(screen.getByTestId("language-system")).toHaveAttribute("aria-checked", "true");
  });

  it("the pseudo-locale is local only and is only offered when allowed", () => {
    const sink = vi.fn();
    setLocaleSink(sink);
    render(<LanguagePicker allowPseudo />);

    act(() => {
      fireEvent.click(screen.getByTestId("language-pseudo"));
    });

    expect(getActiveLocale()).toBe("pseudo");
    expect(window.localStorage.getItem(LOCALE_OVERRIDE_STORAGE_KEY)).toBe("pseudo");
    expect(sink).not.toHaveBeenCalled();
    expect(screen.getByTestId("language-pseudo")).toHaveAttribute("aria-checked", "true");

    act(() => {
      fireEvent.click(screen.getByTestId("language-en"));
    });
    expect(getActiveLocale()).toBe("en");
    expect(window.localStorage.getItem(LOCALE_OVERRIDE_STORAGE_KEY)).toBeNull();
    expect(sink).toHaveBeenCalledWith("en");
  });
});
