import { describe, expect, it } from "vitest";
import type { SummaryGroup } from "@starter/shared";

import { CHART_COLORS, groupColorMap, shadeHex } from "./group-colors";

const group = (
  key: string,
  color: string | null,
  seconds = 3600,
): SummaryGroup => ({
  key,
  label: key,
  color,
  seconds,
  billableSec: 0,
  amount: 0,
});

describe("shadeHex", () => {
  it("mixes towards white and black", () => {
    expect(shadeHex("#000000", 0.5)).toBe("#808080");
    expect(shadeHex("#ffffff", -0.5)).toBe("#808080");
    expect(shadeHex("#4f46e5", 0)).toBe("#4f46e5");
  });

  it("leaves anything that is not a six-digit hex alone", () => {
    expect(shadeHex("hsl(var(--chart-1))", 0.5)).toBe("hsl(var(--chart-1))");
    expect(shadeHex("#fff", 0.5)).toBe("#fff");
  });
});

describe("groupColorMap", () => {
  it("keeps a unique catalogue colour and slots the rest by position", () => {
    const colors = groupColorMap([
      group("a", "#4f46e5"),
      group("b", null),
      group("c", "#ef4444"),
      group("d", null),
    ]);
    expect(colors.get("a")).toBe("#4f46e5");
    expect(colors.get("c")).toBe("#ef4444");
    expect(colors.get("b")).toBe(CHART_COLORS[1]);
    expect(colors.get("d")).toBe(CHART_COLORS[3]);
  });

  it("tells groups sharing a colour apart by shade, biggest keeping it", () => {
    const colors = groupColorMap([
      group("design", "#4f46e5", 5000),
      group("review", "#4f46e5", 4000),
      group("qa", "#4F46E5", 3000),
      group("other", "#ef4444", 2000),
    ]);
    expect(colors.get("design")).toBe("#4f46e5");
    expect(colors.get("review")).toBe(shadeHex("#4f46e5", 0.3));
    expect(colors.get("qa")).toBe(shadeHex("#4F46E5", -0.3));
    expect(colors.get("other")).toBe("#ef4444");
    expect(new Set(colors.values()).size).toBe(4);
  });

  it("gives seven groups of one colour seven different shades", () => {
    const groups = Array.from({ length: 7 }, (_, i) =>
      group(`t${i}`, "#22c55e", 7000 - i * 1000),
    );
    const colors = groupColorMap(groups);
    expect(new Set(colors.values()).size).toBe(7);
  });
});
