import { describe, expect, it } from "vitest";

import {
  atStepBound,
  formatNumberInput,
  parseDecimalInput,
  stepNumberInput,
} from "./number-input-math";

describe("parseDecimalInput", () => {
  it("reads a dot or a comma as the decimal point", () => {
    expect(parseDecimalInput("87.5")).toBe(87.5);
    expect(parseDecimalInput("87,5")).toBe(87.5);
    expect(parseDecimalInput(" 100 ")).toBe(100);
  });

  it("answers null for blank or non-numeric text", () => {
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("   ")).toBeNull();
    expect(parseDecimalInput("1.")).toBe(1);
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("1e999")).toBeNull();
  });
});

describe("formatNumberInput", () => {
  it("prints whole numbers without trailing zeros", () => {
    expect(formatNumberInput(100, 2)).toBe("100");
    expect(formatNumberInput(87.5, 2)).toBe("87.5");
  });

  it("rounds to the precision and never prints float noise", () => {
    expect(formatNumberInput(0.1 + 0.2, 2)).toBe("0.3");
    expect(formatNumberInput(1.005, 2)).toBe("1");
    expect(formatNumberInput(2.5, 0)).toBe("3");
    expect(formatNumberInput(-0.001, 2)).toBe("0");
  });
});

describe("stepNumberInput", () => {
  const money = { step: 1, min: 0, max: 1_000_000, precision: 2 };
  const minutes = { step: 1, min: 1, max: 120, precision: 0 };

  it("moves by a whole step and keeps typed decimals", () => {
    expect(stepNumberInput("100", 1, money)).toBe("101");
    expect(stepNumberInput("87.5", 1, money)).toBe("88.5");
    expect(stepNumberInput("87,5", -1, money)).toBe("86.5");
  });

  it("steps a blank field from zero and into the bounds", () => {
    expect(stepNumberInput("", 1, money)).toBe("1");
    expect(stepNumberInput("", -1, money)).toBe("0");
    expect(stepNumberInput("", 1, minutes)).toBe("1");
    expect(stepNumberInput("", -1, minutes)).toBe("1");
  });

  it("clamps at either bound", () => {
    expect(stepNumberInput("0", -1, money)).toBe("0");
    expect(stepNumberInput("120", 1, minutes)).toBe("120");
    expect(stepNumberInput("1000000", 1, money)).toBe("1000000");
  });

  it("drops decimals a field with precision 0 cannot hold", () => {
    expect(stepNumberInput("4.6", 1, minutes)).toBe("6");
  });

  it("steps from zero when the text is not a number", () => {
    expect(stepNumberInput("abc", 1, money)).toBe("1");
  });
});

describe("atStepBound", () => {
  it("rests the button at the bound and only there", () => {
    expect(atStepBound("0", -1, { min: 0 })).toBe(true);
    expect(atStepBound("1", -1, { min: 0 })).toBe(false);
    expect(atStepBound("120", 1, { max: 120 })).toBe(true);
    expect(atStepBound("", 1, { max: 120 })).toBe(false);
    expect(atStepBound("5", 1, {})).toBe(false);
  });
});
