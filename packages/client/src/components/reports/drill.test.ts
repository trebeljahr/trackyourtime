import { describe, expect, it } from "vitest";

import {
  bucketRange,
  drillIntoBucketPatch,
  drillIntoGroupPatch,
  groupByAfterBucketDrill,
  isDrillableKey,
  nextGroupByAfterDrill,
} from "./drill";
import { pruneDrillTrail } from "./drill-trail-model";
import type { ReportFilterState } from "./use-report-filters";

const state = (patch: Partial<ReportFilterState> = {}): ReportFilterState => ({
  range: { from: "2026-01-01", to: "2026-12-31" },
  projectIds: [],
  clientIds: [],
  taskIds: [],
  tagIds: [],
  memberIds: [],
  billable: "all",
  search: "",
  ...patch,
});

describe("isDrillableKey", () => {
  it("refuses the unassigned bucket and the folded slice", () => {
    expect(isDrillableKey("none")).toBe(false);
    expect(isDrillableKey("__other")).toBe(false);
    expect(isDrillableKey("")).toBe(false);
    expect(isDrillableKey("64a1")).toBe(true);
  });
});

describe("bucketRange", () => {
  const within = { from: "2026-01-01", to: "2026-12-31" };

  it("is the day itself for a day bucket", () => {
    expect(bucketRange("2026-09-07", "day", within)).toEqual({
      from: "2026-09-07",
      to: "2026-09-07",
    });
  });

  it("covers seven days for a week bucket", () => {
    expect(bucketRange("2026-09-07", "week", within)).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
    });
  });

  it("covers the whole month, from a day key or the server's month key", () => {
    expect(bucketRange("2026-02-01", "month", within)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(bucketRange("2024-02", "month", within)).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
  });

  it("clips a bucket at the edge of the range to the range", () => {
    // A Monday week whose first four days are outside the range.
    expect(
      bucketRange("2025-12-29", "week", { from: "2026-01-01", to: "2026-03-31" })
    ).toEqual({ from: "2026-01-01", to: "2026-01-04" });
    expect(
      bucketRange("2026-03-01", "month", { from: "2026-01-01", to: "2026-03-15" })
    ).toEqual({ from: "2026-03-01", to: "2026-03-15" });
  });
});

describe("nextGroupByAfterDrill", () => {
  it("steps down the catalog: client → project → task → tag", () => {
    expect(nextGroupByAfterDrill("client", state())).toBe("project");
    expect(nextGroupByAfterDrill("project", state())).toBe("task");
    expect(nextGroupByAfterDrill("task", state())).toBe("project");
    expect(nextGroupByAfterDrill("tag", state())).toBe("project");
  });

  it("skips a dimension the report is already narrowed to", () => {
    expect(
      nextGroupByAfterDrill("client", state({ projectIds: ["p1"] }))
    ).toBe("task");
    expect(
      nextGroupByAfterDrill(
        "project",
        state({ taskIds: ["t1"], tagIds: ["g1"], clientIds: ["c1"] })
      )
    ).toBe("day");
  });

  it("steps down time: month → week → day → project", () => {
    expect(nextGroupByAfterDrill("month", state())).toBe("week");
    expect(nextGroupByAfterDrill("week", state())).toBe("day");
    expect(nextGroupByAfterDrill("day", state())).toBe("project");
  });

  it("never offers member to somebody without member reporting", () => {
    expect(nextGroupByAfterDrill("client", state(), false)).not.toBe("member");
  });

  it("falls back to a time grouping when everything is pinned", () => {
    const pinned = state({
      projectIds: ["p"],
      clientIds: ["c"],
      taskIds: ["t"],
      tagIds: ["g"],
      range: { from: "2026-09-07", to: "2026-09-07" },
    });
    expect(nextGroupByAfterDrill("project", pinned)).toBe("week");
    expect(nextGroupByAfterDrill("day", pinned)).toBe("day");
  });
});

describe("groupByAfterBucketDrill", () => {
  it("keeps a catalog grouping when the days are narrowed", () => {
    expect(groupByAfterBucketDrill("project", "week", state())).toBe("project");
    expect(groupByAfterBucketDrill("tag", "month", state())).toBe("tag");
  });

  it("steps a time grouping down one unit when it is as coarse as the bar", () => {
    expect(groupByAfterBucketDrill("month", "month", state())).toBe("week");
    expect(groupByAfterBucketDrill("week", "week", state())).toBe("day");
    expect(groupByAfterBucketDrill("month", "week", state())).toBe("day");
  });

  it("keeps a finer time grouping than the bar", () => {
    expect(groupByAfterBucketDrill("day", "week", state())).toBe("day");
    expect(groupByAfterBucketDrill("day", "month", state())).toBe("day");
  });
});

describe("drillIntoGroupPatch", () => {
  it("replaces the dimension's selection and re-groups", () => {
    expect(
      drillIntoGroupPatch("project", "p2", state({ projectIds: ["p1", "p2"] }))
    ).toEqual({ projects: "p2", group: "task" });
  });

  it("writes no group param when the next grouping is the default", () => {
    expect(drillIntoGroupPatch("client", "c1", state())).toEqual({
      clients: "c1",
      group: null,
    });
  });

  it("narrows the range for a time group", () => {
    expect(drillIntoGroupPatch("week", "2026-09-07", state())).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
      group: "day",
    });
    expect(drillIntoGroupPatch("month", "2026-09", state())).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      group: "week",
    });
  });

  it("refuses the unassigned bucket", () => {
    expect(drillIntoGroupPatch("project", "none", state())).toBeNull();
  });
});

describe("drillIntoBucketPatch", () => {
  it("narrows the range and leaves a catalog grouping alone", () => {
    expect(drillIntoBucketPatch("2026-09-07", "day", "project", state())).toEqual(
      { from: "2026-09-07", to: "2026-09-07", group: null }
    );
    expect(drillIntoBucketPatch("2026-09-07", "week", "tag", state())).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
      group: "tag",
    });
  });

  it("steps a time grouping down with the bar", () => {
    expect(
      drillIntoBucketPatch("2026-09-01", "month", "month", state())
    ).toEqual({ from: "2026-09-01", to: "2026-09-30", group: "week" });
  });
});

describe("pruneDrillTrail", () => {
  const trail = [
    { label: "Acme", query: "" },
    { label: "Website", query: "clients=c1" },
    { label: "Design", query: "clients=c1&projects=p1" },
  ];

  it("keeps every step while the report is past the last one", () => {
    expect(pruneDrillTrail(trail, "clients=c1&projects=p1&tasks=t1")).toEqual(
      trail
    );
    expect(pruneDrillTrail(trail, "clients=c1&projects=p2")).toEqual(trail);
  });

  it("drops the step the report went back to, and everything after it", () => {
    expect(pruneDrillTrail(trail, "clients=c1&projects=p1")).toEqual(
      trail.slice(0, 2)
    );
    expect(pruneDrillTrail(trail, "clients=c1")).toEqual(trail.slice(0, 1));
    expect(pruneDrillTrail(trail, "")).toEqual([]);
  });

  it("is a no-op on an empty trail", () => {
    expect(pruneDrillTrail([], "")).toEqual([]);
  });
});
