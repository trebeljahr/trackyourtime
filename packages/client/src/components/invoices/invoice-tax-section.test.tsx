// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  INITIAL_INVOICE_TAX_STATE,
  InvoiceTaxSection,
  lineTaxRenderer,
  missingExemptionNotes,
  pruneLineOverrides,
  stateFromResolvedTax,
  taxInputsFromState,
  type InvoiceTaxState,
} from "./invoice-tax-section";

afterEach(cleanup);

const KEYS = ["project:a", "project:b"];
const state = (overrides: Partial<InvoiceTaxState>): InvoiceTaxState => ({
  ...INITIAL_INVOICE_TAX_STATE,
  touched: true,
  ...overrides,
});

describe("stateFromResolvedTax", () => {
  it("adopts one invoice-wide choice when every line agrees", () => {
    const adopted = stateFromResolvedTax(
      { lines: KEYS.map((key) => ({ key, category: "S" as const, rate: 19 })) },
      {},
    );
    expect(adopted.all).toEqual({ kind: "S19" });
    expect(adopted.perLine).toBe(false);
    expect(adopted.touched).toBe(false);
  });

  it("switches per-line on when the lines differ", () => {
    const adopted = stateFromResolvedTax(
      {
        lines: [
          { key: "project:a", category: "S", rate: 19 },
          { key: "project:b", category: "S", rate: 19 },
          { key: "project:c", category: "E", rate: 0 },
        ],
      },
      { E: "Kein Ausweis von Umsatzsteuer." },
    );
    expect(adopted.all).toEqual({ kind: "S19" });
    expect(adopted.perLine).toBe(true);
    expect(adopted.lines).toEqual({ "project:c": { kind: "E" } });
    expect(adopted.notes.E).toBe("Kein Ausweis von Umsatzsteuer.");
  });

  it("shows unset when nothing resolved", () => {
    expect(stateFromResolvedTax(null, {}).all).toEqual({ kind: "unset" });
  });
});

describe("taxInputsFromState", () => {
  it("sends one tax and its rate for an invoice-wide 19 %", () => {
    expect(taxInputsFromState(state({ all: { kind: "S19" } }), KEYS)).toEqual({
      ok: true,
      inputs: { tax: { category: "S", rate: 19 }, taxRate: 19 },
    });
  });

  it("sends only an empty taxRate for no VAT details", () => {
    expect(taxInputsFromState(state({ all: { kind: "unset" } }), KEYS)).toEqual({
      ok: true,
      inputs: { taxRate: null },
    });
  });

  it("sends a per-line override and the note its category needs", () => {
    const result = taxInputsFromState(
      state({
        all: { kind: "S19" },
        perLine: true,
        lines: { "project:b": { kind: "E" } },
        notes: { E: "§ 4 Nr. 21 UStG" },
      }),
      KEYS,
    );
    expect(result).toEqual({
      ok: true,
      inputs: {
        tax: { category: "S", rate: 19 },
        lineTax: [{ key: "project:b", category: "E", rate: 0 }],
        exemptionNotes: { E: "§ 4 Nr. 21 UStG" },
        taxRate: 19,
      },
    });
  });

  it("refuses to mix not-subject-to-VAT with another category", () => {
    const result = taxInputsFromState(
      state({ all: { kind: "S19" }, perLine: true, lines: { "project:a": { kind: "O" } } }),
      KEYS,
    );
    expect(result).toEqual({ ok: false, errorKey: "oMixed" });
  });

  it("still builds inputs for E without a note, while create is blocked", () => {
    const empty = state({ all: { kind: "E" } });
    expect(taxInputsFromState(empty, KEYS).ok).toBe(true);
    expect(missingExemptionNotes(empty, KEYS)).toEqual(["E"]);
  });

  it("refuses a custom rate that is not a number", () => {
    expect(taxInputsFromState(state({ all: { kind: "Scustom", rate: "abc" } }), KEYS)).toEqual({
      ok: false,
      errorKey: "rate",
    });
  });
});

describe("pruneLineOverrides", () => {
  it("keeps the overrides whose line is still billed and drops the rest", () => {
    const before = state({
      all: { kind: "S19" },
      perLine: true,
      lines: { "project:a": { kind: "E" }, "project:gone": { kind: "S7" } },
    });
    const after = pruneLineOverrides(before, ["project:a", "project:new"]);
    expect(after.lines).toEqual({ "project:a": { kind: "E" } });
    expect(after.perLine).toBe(true);
    expect(after.all).toEqual({ kind: "S19" });
  });

  it("returns the same state when every override still has its line", () => {
    const before = state({ perLine: true, lines: { "project:a": { kind: "E" } } });
    expect(pruneLineOverrides(before, KEYS)).toBe(before);
  });
});

describe("lineTaxRenderer", () => {
  it("renders a control per line only in per-line mode, and each change keeps the others", () => {
    expect(lineTaxRenderer(state({ perLine: false }), () => {}, (line) => line)).toBeNull();
    const onChange = vi.fn();
    const value = state({ all: { kind: "S19" }, perLine: true, lines: { "project:a": { kind: "E" } } });
    const renderLine = lineTaxRenderer(value, onChange, (line) => `VAT for ${line}`);
    expect(renderLine).not.toBeNull();
    render(<>{renderLine?.({ key: "project:b", label: "B" }, 1)}</>);
    fireEvent.change(screen.getByTestId("invoice-line-tax-1"), { target: { value: "S7" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        touched: true,
        lines: { "project:a": { kind: "E" }, "project:b": { kind: "S7" } },
      }),
    );
  });
});

describe("InvoiceTaxSection", () => {
  const renderSection = (
    value: InvoiceTaxState,
    hasBuyerVatId: boolean | null,
    onEditClientBilling: () => void = () => {},
  ): void => {
    render(
      <InvoiceTaxSection
        lines={KEYS.map((key) => ({ key, label: key }))}
        value={value}
        onChange={() => {}}
        hasBuyerVatId={hasBuyerVatId}
        clientId="c1"
        onEditClientBilling={onEditClientBilling}
      />,
    );
  };

  it("opens the client's billing details in place, without navigating away", () => {
    const onEditClientBilling = vi.fn();
    renderSection(state({ all: { kind: "AE" }, notes: { AE: "Reverse charge." } }), false, onEditClientBilling);
    const fix = screen.getByTestId("invoice-tax-ae-fix");
    expect(fix.tagName).toBe("BUTTON");
    fireEvent.click(fix);
    expect(onEditClientBilling).toHaveBeenCalledTimes(1);
  });

  it("warns about a missing buyer VAT ID only for reverse charge", () => {
    renderSection(state({ all: { kind: "AE" }, notes: { AE: "Reverse charge." } }), false);
    expect(screen.getByTestId("invoice-tax-ae-vat-warning")).toBeInTheDocument();
    cleanup();
    renderSection(state({ all: { kind: "AE" }, notes: { AE: "Reverse charge." } }), true);
    expect(screen.queryByTestId("invoice-tax-ae-vat-warning")).not.toBeInTheDocument();
    cleanup();
    renderSection(state({ all: { kind: "S19" } }), false);
    expect(screen.queryByTestId("invoice-tax-ae-vat-warning")).not.toBeInTheDocument();
  });

  it("asks for the reason of an exemption and says so when it is empty", () => {
    renderSection(state({ all: { kind: "E" } }), null);
    expect(screen.getByTestId("invoice-exemption-note-E")).toBeInTheDocument();
    expect(screen.getByTestId("invoice-exemption-note-E-error")).toBeInTheDocument();
  });
});
