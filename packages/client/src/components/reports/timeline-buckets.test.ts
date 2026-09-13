import { addDays, format } from "date-fns";
import { describe, expect, it } from "vitest";
import type { SummaryTimelinePoint } from "@starter/shared";

import {
  bucketTimeline,
  formatBucketLabel,
  granularityForDays,
} from "./timeline-buckets";

const days = (
  from: string,
  count: number,
  seconds = 3600,
  billableSec = 1800,
): SummaryTimelinePoint[] => {
  const start = new Date(`${from}T12:00:00`);
  return Array.from({ length: count }, (_, index) => ({
    date: format(addDays(start, index), "yyyy-MM-dd"),
    seconds,
    billableSec,
  }));
};

describe("granularityForDays", () => {
  it("keeps a quarter daily, two years weekly and longer monthly", () => {
    expect(granularityForDays(92)).toBe("day");
    expect(granularityForDays(93)).toBe("week");
    expect(granularityForDays(731)).toBe("week");
    expect(granularityForDays(732)).toBe("month");
  });
});

describe("bucketTimeline", () => {
  it("passes a short range through one point per day", () => {
    const { granularity, buckets } = bucketTimeline(days("2026-09-07", 7), 1);

    expect(granularity).toBe("day");
    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toEqual({
      date: "2026-09-07",
      billableSec: 1800,
      nonBillableSec: 1800,
    });
  });

  it("rolls a year into weeks on the workspace week start", () => {
    // 2026-01-01 is a Thursday; with Monday weeks the first bucket starts
    // 29 Dec 2025 and holds four days.
    const { granularity, buckets } = bucketTimeline(days("2026-01-01", 365), 1);

    expect(granularity).toBe("week");
    expect(buckets[0]?.date).toBe("2025-12-29");
    expect(buckets[0]?.billableSec).toBe(4 * 1800);
    expect(buckets[1]?.date).toBe("2026-01-05");
    expect(buckets[1]?.billableSec).toBe(7 * 1800);
  });

  it("rolls five years into months and keeps the total", () => {
    const timeline = days("2021-09-14", 1826);
    const { granularity, buckets } = bucketTimeline(timeline, 1);

    expect(granularity).toBe("month");
    expect(buckets[0]?.date).toBe("2021-09-01");
    expect(buckets.at(-1)?.date).toBe("2026-09-01");
    const total = buckets.reduce(
      (sum, bucket) => sum + bucket.billableSec + bucket.nonBillableSec,
      0,
    );
    expect(total).toBe(1826 * 3600);
  });
});

describe("formatBucketLabel", () => {
  it("names each granularity", () => {
    expect(formatBucketLabel("2026-09-07", "day", true)).toBe(
      "Monday, 7 Sep 2026",
    );
    expect(formatBucketLabel("2026-09-07", "week", true)).toBe(
      "Week of 7 Sep 2026",
    );
    expect(formatBucketLabel("2026-09-01", "month")).toBe("Sep 2026");
  });
});
