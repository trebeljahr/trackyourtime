// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NumberField, STEP_COMMIT_DELAY_MS } from "./number-field";

describe("NumberField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("saves a run of steps as one change, at the value the run ended on", () => {
    const onCommit = vi.fn();
    render(<NumberField value={100} onCommit={onCommit} precision={2} testId="rate" />);

    const up = screen.getByTestId("number-input-increase");
    fireEvent.click(up);
    fireEvent.click(up);
    fireEvent.click(screen.getByTestId("number-input-decrease"));
    expect(screen.getByTestId("rate")).toHaveValue("101");
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(STEP_COMMIT_DELAY_MS);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(101);
  });

  it("steps by whole units and keeps the decimals a person typed", () => {
    const onCommit = vi.fn();
    render(<NumberField value={87.5} onCommit={onCommit} precision={2} testId="rate" />);

    fireEvent.keyDown(screen.getByTestId("rate"), { key: "ArrowUp" });
    expect(screen.getByTestId("rate")).toHaveValue("88.5");
    fireEvent.keyDown(screen.getByTestId("rate"), { key: "ArrowUp", shiftKey: true });
    expect(screen.getByTestId("rate")).toHaveValue("98.5");
  });

  it("commits typed text on blur, reading a comma as the decimal point", () => {
    const onCommit = vi.fn();
    render(<NumberField value={100} onCommit={onCommit} precision={2} testId="rate" />);

    const input = screen.getByTestId("rate");
    fireEvent.change(input, { target: { value: "87,5" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(87.5);
    expect(input).toHaveValue("87.5");
  });

  it("rounds a typed value to the field's precision and clamps it", () => {
    const onCommit = vi.fn();
    render(<NumberField value={3} onCommit={onCommit} min={1} max={60} testId="minutes" />);

    const input = screen.getByTestId("minutes");
    fireEvent.change(input, { target: { value: "4.6" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(5);

    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(60);
    expect(screen.getByTestId("number-input-increase")).toBeDisabled();
  });

  it("blur sends a pending step at once, and Escape reverts a draft", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} onCommit={onCommit} testId="days" />);

    const input = screen.getByTestId("days");
    fireEvent.click(screen.getByTestId("number-input-increase"));
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(11);

    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("10");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
