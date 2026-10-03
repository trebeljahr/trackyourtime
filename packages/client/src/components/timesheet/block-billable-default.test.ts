import { describe, expect, it } from "vitest";
import { blockBillableDefault } from "./block-billable-default";

describe("new timesheet block billing defaults", () => {
  it("uses workspace defaults for unassigned blocks", () => {
    expect(blockBillableDefault(undefined, 80, null)).toBe(true);
    expect(blockBillableDefault(undefined, 0, null)).toBe(false);
  });
  it("resolves a project that inherits the workspace rate", () => {
    expect(blockBillableDefault({ billableDefault: true, hourlyRate: null }, 80, null)).toBe(true);
    expect(blockBillableDefault({ billableDefault: true, hourlyRate: null }, 0, null)).toBe(false);
  });
  it("respects an explicit non-billable project and an explicit zero rate", () => {
    expect(blockBillableDefault({ billableDefault: false, hourlyRate: 90 }, 80, null)).toBe(false);
    expect(blockBillableDefault({ billableDefault: true, hourlyRate: 0 }, 80, null)).toBe(false);
  });
  it("uses the member rate before project and workspace rates", () => {
    expect(blockBillableDefault(undefined, 0, 90)).toBe(true);
    expect(blockBillableDefault({ billableDefault: true, hourlyRate: 0 }, 0, 90)).toBe(true);
    expect(blockBillableDefault({ billableDefault: true, hourlyRate: 90 }, 80, 0)).toBe(false);
  });
});
