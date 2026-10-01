// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimeField } from "./time-field";

afterEach(cleanup);
const value = "2026-09-30T09:30:42.000Z";
const mount = () => {
  const commit = vi.fn();
  render(<TimeField value={value} timeZone="UTC" onCommit={commit} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  input.focus();
  return { input, commit };
};

describe("inline start-time editing", () => {
  it("commits Enter exactly once and keeps the entry's time zone", () => {
    const { input, commit } = mount();
    fireEvent.change(input, { target: { value: "08:15" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenCalledExactlyOnceWith("2026-09-30T08:15:00.000Z");
    expect(input.value).toBe("08:15");
  });
  it("cancels Escape without saving the draft", () => {
    const { input, commit } = mount();
    fireEvent.change(input, { target: { value: "08:15" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("09:30");
  });
  it("preserves seconds when focus leaves an unchanged field", () => {
    const { input, commit } = mount();
    fireEvent.blur(input);
    expect(commit).not.toHaveBeenCalled();
  });
  it("saves on blur and rejects invalid input", () => {
    const { input, commit } = mount();
    fireEvent.change(input, { target: { value: "08:15" } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledExactlyOnceWith("2026-09-30T08:15:00.000Z");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});
