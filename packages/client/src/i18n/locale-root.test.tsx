// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_PENDING_ATTRIBUTE, LOCALE_STORAGE_KEY } from "@/i18n/config";
import { FixedLocale, LocaleRoot } from "@/i18n/locale-root";
import { getActiveLocale, resetLocaleStoreForTests } from "@/i18n/locale-store";
import { useT } from "@/i18n/use-t";

/*
 * The hydration contract, run for real: prerender in English (what `next
 * build` writes), then hydrate as a German reader would load it.
 *
 * The two ways this breaks are both silent in a normal test. Rendering the
 * target language during hydration produces a text mismatch React reports
 * only as a console error and then "fixes" by discarding the served DOM; and a
 * gate that is never lifted leaves an invisible page that every assertion
 * against the DOM still passes.
 */

function Probe(): React.JSX.Element {
  const t = useT("common");
  return <p data-testid="probe">{t("actions.save")}</p>;
}

const App = (): React.JSX.Element => (
  <LocaleRoot>
    <Probe />
    <FixedLocale locale="en">
      <span data-testid="fixed">
        <FixedProbe />
      </span>
    </FixedLocale>
  </LocaleRoot>
);

function FixedProbe(): React.JSX.Element {
  const t = useT("common");
  return <>{t("actions.cancel")}</>;
}

// React only warns about act() when told it is in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  resetLocaleStoreForTests();
  document.documentElement.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  resetLocaleStoreForTests();
});

describe("LocaleRoot", () => {
  it("hydrates the English HTML without a mismatch, then renders German and lifts the gate", async () => {
    const html = renderToString(<App />);
    expect(html).toContain("Save");

    // The German reader's browser, after LOCALE_SCRIPT ran.
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    document.documentElement.setAttribute(LOCALE_PENDING_ATTRIBUTE, "");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const served = container.querySelector("[data-testid=probe]");

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      hydrateRoot(container, <App />, {
        onRecoverableError: (error) => {
          throw error;
        },
      });
    });

    expect(errors).not.toHaveBeenCalled();
    expect(getActiveLocale()).toBe("de");
    // Same node: hydration adopted the served DOM rather than replacing it.
    expect(container.querySelector("[data-testid=probe]")).toBe(served);
    expect(served?.textContent).toBe("Speichern");
    expect(document.documentElement.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
    expect(document.documentElement.lang).toBe("de");
    // A fixed-locale subtree ignores the preference.
    expect(container.querySelector("[data-testid=fixed]")?.textContent).toBe("Cancel");
  });

  it("lifts the gate for an English reader too", async () => {
    const html = renderToString(<App />);
    document.documentElement.setAttribute(LOCALE_PENDING_ATTRIBUTE, "");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <App />);
    });

    expect(getActiveLocale()).toBe("en");
    expect(document.documentElement.hasAttribute(LOCALE_PENDING_ATTRIBUTE)).toBe(false);
  });
});
