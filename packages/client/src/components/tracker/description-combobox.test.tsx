// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DescriptionSuggestion } from "@starter/core";

const suggestion = (
  description: string,
  overrides: Partial<DescriptionSuggestion> = {},
): DescriptionSuggestion => ({
  description,
  projectId: null,
  taskId: null,
  billable: false,
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  projectMissing: false,
  projectArchived: false,
  taskMissing: false,
  tagIds: [],
  lastStart: "2026-09-01T09:00:00.000Z",
  lastEntryId: `e-${description}`,
  count: 1,
  ...overrides,
});

let rows: DescriptionSuggestion[] = [];
const searched = vi.fn();

// Answers every query at once, so the test is about the keyboard contract and
// not about debouncing.
vi.mock("@/components/tracker/use-description-suggestions", () => ({
  useDescriptionSuggestions: (text: string, enabled: boolean) => {
    searched(text, enabled);
    return { rows, rowsFor: text.trim() };
  },
}));

import { DescriptionCombobox } from "./description-combobox";

type Handlers = {
  onCommit: ReturnType<typeof vi.fn<(next: string) => void>>;
  onSubmit: ReturnType<typeof vi.fn<() => void>>;
  onFill: ReturnType<typeof vi.fn<(s: DescriptionSuggestion) => void>>;
};

function Harness({
  committed = "",
  handlers,
}: {
  committed?: string;
  handlers: Handlers;
}): React.JSX.Element {
  const [value, setValue] = React.useState(committed);
  return (
    <>
      <DescriptionCombobox
        value={value}
        onValueChange={setValue}
        committed={committed}
        onCommit={handlers.onCommit}
        onSubmit={handlers.onSubmit}
        onFill={handlers.onFill}
      />
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
    </>
  );
}

const setup = (committed = "") => {
  const handlers: Handlers = {
    onCommit: vi.fn<(next: string) => void>(),
    onSubmit: vi.fn<() => void>(),
    onFill: vi.fn<(s: DescriptionSuggestion) => void>(),
  };
  render(<Harness committed={committed} handlers={handlers} />);
  const input = screen.getByTestId("tracker-description") as HTMLInputElement;
  return { handlers, input };
};

const type = (input: HTMLInputElement, text: string): void => {
  input.focus();
  fireEvent.change(input, { target: { value: text } });
};

beforeEach(() => {
  rows = [
    suggestion("Design review", {
      projectId: "p1",
      taskId: "t1",
      billable: true,
      tagIds: ["g1"],
      projectName: "Website",
    }),
    suggestion("Design system"),
  ];
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("DescriptionCombobox", () => {
  it("shows past descriptions while typing, with nothing highlighted", () => {
    const { input } = setup();
    type(input, "Design");
    const options = screen.getAllByTestId("tracker-description-suggestion");
    expect(options.map((node) => node.textContent)).toEqual([
      expect.stringContaining("Design review"),
      "Design system",
    ]);
    expect(options.every((node) => node.getAttribute("aria-selected") === "false")).toBe(true);
    expect(searched).toHaveBeenLastCalledWith("Design", true);
  });

  it("does not ask the server until the list is wanted", () => {
    setup();
    expect(searched).toHaveBeenLastCalledWith("", false);
  });

  it("Enter without arrowing submits the typed text", () => {
    const { input, handlers } = setup();
    type(input, "Design");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
    expect(handlers.onCommit).toHaveBeenCalledWith("Design");
    expect(input.value).toBe("Design");
    expect(handlers.onFill).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tracker-description-suggestion")).toBeNull();
  });

  it("arrows highlight, and Enter then takes the name only", () => {
    const { input, handlers } = setup();
    type(input, "Design");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const [first] = screen.getAllByTestId("tracker-description-suggestion");
    expect(first?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Design review");
    expect(handlers.onSubmit).not.toHaveBeenCalled();
    expect(handlers.onFill).not.toHaveBeenCalled();
    expect(handlers.onCommit).toHaveBeenCalledWith("Design review");
  });

  it("an arrow pressed before the rows arrive highlights the first one", () => {
    const loaded = rows;
    rows = [];
    const { input, handlers } = setup();
    type(input, "Design");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.queryByTestId("tracker-description-suggestion")).toBeNull();

    rows = loaded;
    fireEvent.change(input, { target: { value: "Design " } });
    fireEvent.change(input, { target: { value: "Design" } });
    const [first] = screen.getAllByTestId("tracker-description-suggestion");
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it("ArrowUp past the first row returns to nothing highlighted", () => {
    const { input, handlers } = setup();
    type(input, "Design");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Tab completes the top row's name", () => {
    const { input, handlers } = setup();
    type(input, "Design");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("Design review");
    expect(handlers.onFill).not.toHaveBeenCalled();
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter on a highlighted row fills every field and keeps the page toggle out", () => {
    const pageToggle = vi.fn();
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) pageToggle();
    };
    window.addEventListener("keydown", onWindowKey);
    try {
      const { input, handlers } = setup();
      type(input, "Design");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      expect(handlers.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Design review",
          projectId: "p1",
          taskId: "t1",
          billable: true,
          tagIds: ["g1"],
        }),
      );
      expect(handlers.onSubmit).not.toHaveBeenCalled();
      expect(pageToggle).not.toHaveBeenCalled();
      expect(input.value).toBe("Design review");
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("the row's fill button is the pointer's secondary action", () => {
    const { input, handlers } = setup();
    type(input, "Design");
    // Only the row that carries fields offers it.
    const fills = screen.getAllByTestId("tracker-description-fill");
    expect(fills).toHaveLength(1);
    fireEvent.mouseDown(fills[0] as HTMLElement);
    expect(handlers.onFill).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Design review" }),
    );
  });

  it("commits on blur", () => {
    const { input, handlers } = setup("Old text");
    type(input, "New text");
    rows = [];
    fireEvent.blur(input);
    expect(handlers.onCommit).toHaveBeenCalledWith("New text");
  });

  it("does not commit an untouched field on blur", () => {
    const { input, handlers } = setup("Old text");
    input.focus();
    fireEvent.blur(input);
    expect(handlers.onCommit).not.toHaveBeenCalled();
  });

  it("Escape closes the list first, then reverts without saving", () => {
    const { input, handlers } = setup("Old text");
    type(input, "Design");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("tracker-description-suggestion")).toBeNull();
    expect(input.value).toBe("Design");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("Old text");
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
  });
});
