// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DurationInput } from "@/components/duration-input";
import {
  commitTargetLocale,
  resetLocaleStoreForTests,
  setLocalePreference,
} from "@/i18n/locale-store";

/*
 * A German reader types a decimal comma, an English one a dot, and anyone may
 * paste the other: the field must accept both whatever language it renders
 * in, and print back in the reader's own form.
 */

const NBSP = " ";

const setNavigatorLanguages = (languages: string[]): void => {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
};

const type = (value: string): void => {
  const input = screen.getByTestId("duration-input");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

beforeEach(() => {
  window.localStorage.clear();
  setNavigatorLanguages(["en-US"]);
  resetLocaleStoreForTests();
  act(() => commitTargetLocale());
});

afterEach(() => {
  cleanup();
  resetLocaleStoreForTests();
});

describe("DurationInput decimal separators", () => {
  for (const input of ["1,5h", "1.5h", "1,5 h", "1.5 h"]) {
    it(`accepts "${input}" as an hour and a half`, () => {
      const onCommit = vi.fn();
      render(<DurationInput value={0} onCommit={onCommit} format="decimal" />);
      type(input);
      expect(onCommit).toHaveBeenCalledWith(5400);
    });
  }

  for (const input of ["1,5", "1.5"]) {
    it(`reads a bare "${input}" the same way with either separator`, () => {
      const onCommit = vi.fn();
      render(<DurationInput value={0} onCommit={onCommit} format="decimal" />);
      type(input);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0]?.[0]).toBe(90);
    });
  }

  it("prints English with a dot and German with a comma", () => {
    const { rerender } = render(
      <DurationInput value={5400} onCommit={() => undefined} format="decimal" />,
    );
    expect(screen.getByTestId("duration-input")).toHaveValue("1.50 h");

    act(() => setLocalePreference("de"));
    rerender(<DurationInput value={5400} onCommit={() => undefined} format="decimal" />);
    expect(screen.getByTestId("duration-input")).toHaveValue(`1,50${NBSP}h`);
  });

  it("accepts a dot while rendering German", () => {
    act(() => setLocalePreference("de"));
    const onCommit = vi.fn();
    render(<DurationInput value={0} onCommit={onCommit} format="decimal" />);
    type("2.25h");
    expect(onCommit).toHaveBeenCalledWith(8100);
    expect(screen.getByTestId("duration-input")).toHaveValue(`2,25${NBSP}h`);
  });
});
