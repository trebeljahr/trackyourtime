// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDeepLinkFocus } from "./use-deep-link-focus";

function Harness({ field }: { field: string | null }): React.JSX.Element {
  const root = React.useRef<HTMLDivElement>(null);
  useDeepLinkFocus(root, true, field);
  return (
    <div ref={root}>
      <div data-field="vatId" data-testid="row">
        <input data-testid="input" />
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDeepLinkFocus", () => {
  it("highlights and focuses the row under StrictMode, then clears the highlight", () => {
    render(
      <React.StrictMode>
        <Harness field="vatId" />
      </React.StrictMode>,
    );
    const row = screen.getByTestId("row");
    expect(row).toHaveAttribute("data-highlight", "true");
    expect(screen.getByTestId("input")).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).not.toHaveAttribute("data-highlight");
  });

  it("removes the highlight when the host unmounts early", () => {
    const { unmount } = render(<Harness field="vatId" />);
    const row = screen.getByTestId("row");
    expect(row).toHaveAttribute("data-highlight", "true");
    unmount();
    expect(row).not.toHaveAttribute("data-highlight");
  });
});
