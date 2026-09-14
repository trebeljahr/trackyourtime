// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { TaxChoice } from "./billing-fields";
import { TaxCategorySelect, TaxChoiceSelect } from "./tax-choice-select";

afterEach(cleanup);

const optionValues = (testId: string): string[] =>
  Array.from(screen.getByTestId(testId).querySelectorAll("option"))
    .map((option) => option.getAttribute("value") ?? "")
    .filter((value) => value !== "");

describe("TaxChoiceSelect", () => {
  it("offers 8 choices in full mode and the four 0 % categories in zero-rate mode", () => {
    render(<TaxChoiceSelect value={{ kind: "S19" }} onChange={() => {}} testId="full" />);
    expect(optionValues("full")).toEqual(["S19", "S7", "Scustom", "Z", "E", "AE", "O", "unset"]);
    render(<TaxChoiceSelect mode="zeroRate" value={null} onChange={() => {}} testId="zero" />);
    expect(optionValues("zero")).toEqual(["E", "AE", "O", "Z"]);
    expect(screen.getByTestId("zero")).toHaveValue("");
  });

  it("offers 6 options in category-only mode", () => {
    render(<TaxCategorySelect value={null} onChange={() => {}} testId="category" />);
    expect(optionValues("category")).toEqual(["unset", "S", "Z", "E", "AE", "O"]);
  });

  it("reveals the custom rate input and reports the typed rate", () => {
    const onChange = vi.fn<(next: TaxChoice) => void>();
    const { rerender } = render(<TaxChoiceSelect value={{ kind: "S19" }} onChange={onChange} testId="tax" />);
    expect(screen.queryByTestId("tax-custom-rate")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("tax"), { target: { value: "Scustom" } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "Scustom", rate: "" });
    rerender(<TaxChoiceSelect value={{ kind: "Scustom", rate: "" }} onChange={onChange} testId="tax" />);
    fireEvent.change(screen.getByTestId("tax-custom-rate"), { target: { value: "16" } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "Scustom", rate: "16" });
  });

  it("explains reverse charge under the control", () => {
    render(<TaxChoiceSelect value={{ kind: "AE" }} onChange={() => {}} testId="tax" />);
    expect(screen.getByTestId("tax-hint")).toHaveTextContent("VAT ID");
  });
});
