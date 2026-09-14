// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalePreference } from "@starter/shared";

import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import {
  commitTargetLocale,
  getActiveLocale,
  resetLocaleStoreForTests,
} from "@/i18n/locale-store";

/*
 * The picker and <LocaleSync> together, as the app shell mounts them: a click
 * on "Deutsch" must reach `settings.update` with the preference (and this
 * tab's originId), re-render in German at once and leave the localStorage
 * mirror the pre-paint script reads on the next load. A preference that
 * arrives FROM the server is adopted without being echoed back.
 */

const serverSettings: { data: { locale?: LocalePreference } | undefined } = {
  data: undefined,
};
const mutate = vi.fn();
const setData = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ settings: { get: { setData } } }),
    settings: {
      get: { useQuery: () => serverSettings },
      update: { useMutation: () => ({ mutate }) },
    },
  },
}));

const { LocaleSync } = await import("@/i18n/locale-sync");
const { LanguagePicker } = await import("@/components/settings/language-picker");
const { ORIGIN_ID } = await import("@/hooks/use-sync");

const setNavigatorLanguages = (languages: string[]): void => {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
};

beforeEach(() => {
  window.localStorage.clear();
  setNavigatorLanguages(["en-US"]);
  serverSettings.data = { locale: "system" };
  resetLocaleStoreForTests();
  act(() => commitTargetLocale());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLocaleStoreForTests();
});

describe("LanguagePicker + LocaleSync", () => {
  it("saves a choice through settings.update, switches the UI and mirrors it locally", () => {
    render(
      <>
        <LocaleSync />
        <LanguagePicker allowPseudo={false} />
      </>,
    );
    expect(screen.getByText("Language")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("language-de"));
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ locale: "de", originId: ORIGIN_ID });
    expect(getActiveLocale()).toBe("de");
    expect(screen.getByText("Sprache")).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    expect(document.documentElement.lang).toBe("de");
  });

  it("adopts the server's preference without sending it back", () => {
    serverSettings.data = { locale: "de" };
    render(
      <>
        <LocaleSync />
        <LanguagePicker allowPseudo={false} />
      </>,
    );

    expect(getActiveLocale()).toBe("de");
    expect(screen.getByTestId("language-de")).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    expect(mutate).not.toHaveBeenCalled();
  });
});
