import { describe, expect, it } from "vitest";
import type { SummaryGroup } from "@starter/shared";

import { NO_PROJECT_COLOR } from "./entry-color";
import { daySharesOf, heatFill, intensityOf } from "./year-heat";

const group = (key: string, color: string | null): SummaryGroup => ({
  key,
  label: `Project ${key}`,
  color,
  seconds: 0,
  billableSec: 0,
  amount: 0,
});

const groups = new Map<string, SummaryGroup>([
  ["a", group("a", "#336699")],
  ["b", group("b", "#993366")],
  ["none", { ...group("none", null), label: "No project" }],
]);

describe("intensityOf", () => {
  it("is 0 for nothing tracked and 4 for the busiest day", () => {
    expect(intensityOf(0, 3600)).toBe(0);
    expect(intensityOf(3600, 0)).toBe(0);
    expect(intensityOf(3600, 3600)).toBe(4);
  });

  it("buckets by quarter of the busiest day", () => {
    expect(intensityOf(900, 3600)).toBe(1);
    expect(intensityOf(1800, 3600)).toBe(2);
    expect(intensityOf(2700, 3600)).toBe(3);
    expect(intensityOf(2701, 3600)).toBe(4);
  });
});

describe("daySharesOf", () => {
  it("resolves each share to its group's label and color, in the server's order", () => {
    expect(
      daySharesOf(
        {
          date: "2026-03-04",
          seconds: 5400,
          billableSec: 0,
          shares: [
            { key: "a", seconds: 3600 },
            { key: "b", seconds: 1800 },
          ],
        },
        groups,
        "No project"
      )
    ).toEqual([
      { key: "a", label: "Project a", color: "#336699", seconds: 3600 },
      { key: "b", label: "Project b", color: "#993366", seconds: 1800 },
    ]);
  });

  it("paints no-project time slate and names it in the reader's language", () => {
    expect(
      daySharesOf(
        {
          date: "2026-03-04",
          seconds: 60,
          billableSec: 0,
          shares: [{ key: "none", seconds: 60 }],
        },
        groups,
        "Kein Projekt"
      )
    ).toEqual([
      { key: "none", label: "Kein Projekt", color: NO_PROJECT_COLOR, seconds: 60 },
    ]);
  });

  it("falls back to slate for a group the report does not list", () => {
    const [share] = daySharesOf(
      {
        date: "2026-03-04",
        seconds: 60,
        billableSec: 0,
        shares: [{ key: "gone", seconds: 60 }],
      },
      groups,
      "No project"
    ) ?? [];
    expect(share?.color).toBe(NO_PROJECT_COLOR);
    expect(share?.label).toBe("gone");
  });

  it("is null when the server sent no split, so the view keeps one hue", () => {
    expect(
      daySharesOf(
        { date: "2026-03-04", seconds: 60, billableSec: 0 },
        groups,
        "No project"
      )
    ).toBeNull();
    expect(daySharesOf(undefined, groups, "No project")).toBeNull();
  });
});

describe("heatFill", () => {
  it("is null for an untracked day and stronger for a busier one", () => {
    expect(heatFill("#336699", 0)).toBeNull();
    expect(heatFill("#336699", 1)).toBe("color-mix(in srgb, #336699 28%, transparent)");
    expect(heatFill("#336699", 4)).toBe("color-mix(in srgb, #336699 90%, transparent)");
  });
});
