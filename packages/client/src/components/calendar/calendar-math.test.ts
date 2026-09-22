import { describe, expect, it } from "vitest";

import {
  MINUTES_PER_DAY,
  ZOOM_LEVELS,
  clampZoomIndex,
  clusterMicroBlocks,
  gridTicks,
  zoomPxPerMinute,
  blockGeometry,
  daySegment,
  expandVisibleRange,
  formatMinuteOfDay,
  isoAtMinute,
  layoutBlocks,
  minutesFromOffset,
  moveRange,
  offsetFromMinutes,
  rangeFromClick,
  rangeFromDrag,
  resizeRange,
  snapMinutes,
} from "./calendar-math";

const DAY_MS = MINUTES_PER_DAY * 60_000;

describe("snapMinutes", () => {
  it("rounds to the nearest 5-minute slot", () => {
    expect(snapMinutes(62)).toBe(60);
    expect(snapMinutes(63)).toBe(65);
    expect(snapMinutes(-3)).toBe(-5);
  });
});

describe("minutesFromOffset / offsetFromMinutes", () => {
  it("round-trips a pixel offset through the visible range", () => {
    const range = { startMin: 360, endMin: 1320 };
    const minute = minutesFromOffset(120, 1, range);
    expect(minute).toBe(480);
    expect(offsetFromMinutes(minute, 1, range)).toBe(120);
  });
});

describe("moveRange", () => {
  it("keeps the duration and snaps the new start", () => {
    expect(moveRange({ startMin: 540, endMin: 600 }, 32)).toEqual({
      startMin: 570,
      endMin: 630,
    });
  });

  it("clamps to the day instead of clipping the block", () => {
    expect(moveRange({ startMin: 0, endMin: 60 }, -120)).toEqual({
      startMin: 0,
      endMin: 60,
    });
    expect(moveRange({ startMin: 1380, endMin: 1440 }, 120)).toEqual({
      startMin: 1380,
      endMin: 1440,
    });
  });
});

describe("resizeRange", () => {
  it("moves only the dragged edge", () => {
    expect(resizeRange({ startMin: 540, endMin: 600 }, "start", -33)).toEqual({
      startMin: 505,
      endMin: 600,
    });
    expect(resizeRange({ startMin: 540, endMin: 600 }, "end", 18)).toEqual({
      startMin: 540,
      endMin: 620,
    });
  });

  it("never lets the edges cross", () => {
    expect(resizeRange({ startMin: 540, endMin: 600 }, "start", 999)).toEqual({
      startMin: 595,
      endMin: 600,
    });
    expect(resizeRange({ startMin: 540, endMin: 600 }, "end", -999)).toEqual({
      startMin: 540,
      endMin: 545,
    });
  });
});

describe("rangeFromClick", () => {
  it("proposes an hour from the slot the click landed in", () => {
    expect(rangeFromClick(547)).toEqual({ startMin: 540, endMin: 600 });
    expect(rangeFromClick(559)).toEqual({ startMin: 555, endMin: 615 });
  });

  it("stays inside the day", () => {
    expect(rangeFromClick(1430)).toEqual({ startMin: 1380, endMin: 1440 });
    expect(rangeFromClick(-5)).toEqual({ startMin: 0, endMin: 60 });
  });

  it("never proposes less than the minimum duration", () => {
    expect(rangeFromClick(600, 1)).toEqual({ startMin: 600, endMin: 605 });
  });
});

describe("rangeFromDrag", () => {
  it("works in either direction", () => {
    expect(rangeFromDrag(600, 540)).toEqual({ startMin: 540, endMin: 600 });
    expect(rangeFromDrag(540, 600)).toEqual({ startMin: 540, endMin: 600 });
  });

  it("enforces a minimum duration, staying inside the day", () => {
    expect(rangeFromDrag(600, 601)).toEqual({ startMin: 600, endMin: 605 });
    expect(rangeFromDrag(1440, 1440)).toEqual({
      startMin: 1435,
      endMin: 1440,
    });
  });
});

describe("daySegment", () => {
  const dayStart = new Date(2026, 7, 21).getTime();
  const dayEnd = dayStart + DAY_MS;

  it("returns the clipped minutes for an entry inside the day", () => {
    const segment = daySegment(
      dayStart + 9 * 60 * 60_000,
      dayStart + 10.5 * 60 * 60_000,
      dayStart,
      dayEnd
    );
    expect(segment).toEqual({
      startMin: 540,
      endMin: 630,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  it("flags entries that spill across midnight", () => {
    const segment = daySegment(
      dayStart - 60 * 60_000,
      dayEnd + 60 * 60_000,
      dayStart,
      dayEnd
    );
    expect(segment).toEqual({
      startMin: 0,
      endMin: 1440,
      continuesBefore: true,
      continuesAfter: true,
    });
  });

  it("returns null for entries on another day", () => {
    expect(
      daySegment(dayEnd + 60_000, dayEnd + 120_000, dayStart, dayEnd)
    ).toBeNull();
  });
});

describe("layoutBlocks", () => {
  it("gives non-overlapping blocks the full width", () => {
    const out = layoutBlocks([
      { id: "a", startMin: 0, endMin: 60 },
      { id: "b", startMin: 60, endMin: 120 },
    ]);
    expect(out.map((block) => [block.id, block.column, block.columns])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("splits overlapping blocks into side-by-side columns", () => {
    const out = layoutBlocks([
      { id: "a", startMin: 0, endMin: 120 },
      { id: "b", startMin: 30, endMin: 90 },
      { id: "c", startMin: 60, endMin: 150 },
    ]);
    const byId = new Map(out.map((block) => [block.id, block]));
    expect(byId.get("a")?.column).toBe(0);
    expect(byId.get("b")?.column).toBe(1);
    expect(byId.get("c")?.column).toBe(2);
    expect(out.every((block) => block.columns === 3)).toBe(true);
  });

  it("reuses a column once the earlier block has ended", () => {
    const out = layoutBlocks([
      { id: "a", startMin: 0, endMin: 60 },
      { id: "b", startMin: 30, endMin: 90 },
      { id: "c", startMin: 60, endMin: 120 },
    ]);
    const byId = new Map(out.map((block) => [block.id, block]));
    expect(byId.get("c")?.column).toBe(0);
    expect(byId.get("c")?.columns).toBe(2);
  });

  it("grows a block across columns nothing overlapping occupies", () => {
    const out = layoutBlocks([
      { id: "a", startMin: 0, endMin: 180 },
      { id: "b", startMin: 0, endMin: 60 },
      { id: "c", startMin: 30, endMin: 90 },
      { id: "d", startMin: 120, endMin: 150 },
    ]);
    const byId = new Map(out.map((block) => [block.id, block]));
    expect(out.every((block) => block.columns === 3)).toBe(true);
    // `d` sits in column 1 and column 2 is free while it runs, so it takes both
    // rather than leaving a third of the column empty.
    expect(byId.get("d")).toMatchObject({ column: 1, span: 2 });
    expect(byId.get("a")).toMatchObject({ column: 0, span: 1 });
  });
});

describe("blockGeometry", () => {
  it("gives a lone block the whole column", () => {
    expect(blockGeometry({ column: 0, columns: 1, span: 1 })).toMatchObject({
      leftPct: 0,
      widthPct: 100,
      stacked: false,
    });
  });

  it("splits small clusters evenly and honours the span", () => {
    expect(blockGeometry({ column: 0, columns: 2, span: 1 })).toMatchObject({
      leftPct: 0,
      widthPct: 50,
    });
    const wide = blockGeometry({ column: 1, columns: 3, span: 2 });
    expect(wide.leftPct).toBeCloseTo(100 / 3);
    expect(wide.widthPct).toBeCloseTo(200 / 3);
  });

  it("never lets a span run past the last column", () => {
    const geometry = blockGeometry({ column: 2, columns: 3, span: 9 });
    expect(geometry.leftPct + geometry.widthPct).toBeCloseTo(100);
  });

  it("shingles clusters too wide to split, keeping every block readable", () => {
    const columns = 6;
    const geometries = Array.from({ length: columns }, (_, column) =>
      blockGeometry({ column, columns, span: 1 })
    );

    // Every block runs to the right edge, so none is a sliver.
    for (const geometry of geometries) {
      expect(geometry.leftPct + geometry.widthPct).toBeCloseTo(100);
      expect(geometry.widthPct).toBeGreaterThan(100 / columns);
    }
    // Each one starts further right than the last, and paints above it.
    for (let index = 1; index < columns; index += 1) {
      expect(geometries[index]!.leftPct).toBeGreaterThan(
        geometries[index - 1]!.leftPct
      );
      expect(geometries[index]!.zIndex).toBeGreaterThan(
        geometries[index - 1]!.zIndex
      );
      expect(geometries[index]!.stacked).toBe(true);
    }
    expect(geometries[0]!.stacked).toBe(false);
  });
});

describe("formatMinuteOfDay", () => {
  it("renders both clock formats", () => {
    expect(formatMinuteOfDay(555)).toBe("09:15");
    expect(formatMinuteOfDay(555, "12h")).toBe("9:15 AM");
    expect(formatMinuteOfDay(0, "12h")).toBe("12:00 AM");
    expect(formatMinuteOfDay(780, "12h")).toBe("1:00 PM");
  });
});

describe("isoAtMinute", () => {
  it("anchors a minute-of-day to a local calendar day", () => {
    const iso = isoAtMinute(new Date(2026, 7, 21), 9 * 60 + 30);
    const parsed = new Date(iso);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(21);
    expect(parsed.getHours()).toBe(9);
    expect(parsed.getMinutes()).toBe(30);
  });
});

describe("expandVisibleRange", () => {
  it("keeps the preferred window when everything fits", () => {
    expect(
      expandVisibleRange({ startMin: 360, endMin: 1320 }, [
        { startMin: 540, endMin: 600 },
      ])
    ).toEqual({ startMin: 360, endMin: 1320 });
  });

  it("widens to whole hours around out-of-window entries", () => {
    expect(
      expandVisibleRange({ startMin: 360, endMin: 1320 }, [
        { startMin: 310, endMin: 1370 },
      ])
    ).toEqual({ startMin: 300, endMin: 1380 });
  });
});

describe("zoom ladder", () => {
  it("clamps an index to the ladder", () => {
    expect(clampZoomIndex(-3)).toBe(0);
    expect(clampZoomIndex(99)).toBe(ZOOM_LEVELS.length - 1);
    expect(zoomPxPerMinute(-1)).toBe(ZOOM_LEVELS[0]);
    expect(zoomPxPerMinute(ZOOM_LEVELS.length)).toBe(
      ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
    );
  });

  it("keeps 1px per minute on the ladder as the baseline", () => {
    expect(ZOOM_LEVELS).toContain(1);
  });
});

describe("gridTicks", () => {
  it("thins the rules out as the grid shrinks", () => {
    expect(gridTicks(1)).toEqual({ labelStepMin: 60, minorStepMin: 30 });
    expect(gridTicks(0.6)).toEqual({ labelStepMin: 60, minorStepMin: null });
    expect(gridTicks(0.5)).toEqual({ labelStepMin: 120, minorStepMin: 60 });
    expect(gridTicks(0.3)).toEqual({ labelStepMin: 180, minorStepMin: 60 });
  });

  it("subdivides the hour as the grid grows", () => {
    expect(gridTicks(1.5)).toEqual({ labelStepMin: 30, minorStepMin: 15 });
    expect(gridTicks(2)).toEqual({ labelStepMin: 30, minorStepMin: 15 });
    expect(gridTicks(3)).toEqual({ labelStepMin: 15, minorStepMin: 5 });
    expect(gridTicks(4)).toEqual({ labelStepMin: 10, minorStepMin: 5 });
    expect(gridTicks(6)).toEqual({ labelStepMin: 5, minorStepMin: null });
  });

  it("keeps labels legible and every hour on a labelled line", () => {
    for (const pxPerMinute of ZOOM_LEVELS) {
      const { labelStepMin, minorStepMin } = gridTicks(pxPerMinute);
      expect(labelStepMin * pxPerMinute).toBeGreaterThanOrEqual(30);
      if (labelStepMin < 60) expect(60 % labelStepMin).toBe(0);
      if (minorStepMin !== null) {
        expect(minorStepMin * pxPerMinute).toBeGreaterThanOrEqual(15);
        expect(labelStepMin % minorStepMin).toBe(0);
      }
    }
  });
});

describe("clusterMicroBlocks", () => {
  const micro = (id: string, startMin: number, length = 4) => ({
    id,
    startMin,
    endMin: startMin + length,
  });

  it("collapses a burst of unreadably short blocks", () => {
    const blocks = [micro("a", 540), micro("b", 546), micro("c", 552)];
    const { loose, clusters } = clusterMicroBlocks(blocks, 1);

    expect(loose).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members.map((member) => member.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(clusters[0]).toMatchObject({ startMin: 540, endMin: 556 });
  });

  it("leaves readable blocks alone", () => {
    const blocks = [
      micro("a", 540),
      micro("b", 546),
      micro("c", 552),
      { id: "long", startMin: 600, endMin: 660 },
    ];
    const { loose, clusters } = clusterMicroBlocks(blocks, 1);

    expect(loose.map((block) => block.id)).toEqual(["long"]);
    expect(clusters).toHaveLength(1);
  });

  it("does not cluster short blocks spread across the day", () => {
    const blocks = [micro("a", 540), micro("b", 700), micro("c", 900)];
    const { loose, clusters } = clusterMicroBlocks(blocks, 1);

    expect(clusters).toEqual([]);
    expect(loose.map((block) => block.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("needs at least three blocks before it collapses anything", () => {
    const { loose, clusters } = clusterMicroBlocks(
      [micro("a", 540), micro("b", 546)],
      1
    );

    expect(clusters).toEqual([]);
    expect(loose).toHaveLength(2);
  });

  it("dissolves the cluster once zoom makes the blocks readable", () => {
    const blocks = [micro("a", 540), micro("b", 546), micro("c", 552)];

    expect(clusterMicroBlocks(blocks, 1).clusters).toHaveLength(1);
    expect(clusterMicroBlocks(blocks, 4).clusters).toEqual([]);
    expect(clusterMicroBlocks(blocks, 4).loose).toHaveLength(3);
  });

  it("splits one burst from another when the gap is wide enough", () => {
    const blocks = [
      micro("a", 540),
      micro("b", 546),
      micro("c", 552),
      micro("d", 600),
      micro("e", 606),
      micro("f", 612),
    ];
    const { clusters } = clusterMicroBlocks(blocks, 1);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.members).toHaveLength(3);
    expect(clusters[1]?.members).toHaveLength(3);
  });
});
