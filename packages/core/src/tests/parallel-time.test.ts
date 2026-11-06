import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clipInterval,
  OverlapCollector,
  overlappingIntervals,
  parallelShares,
  wallClockSeconds,
  zonedDayBuckets,
  type ParallelInterval,
} from "@starter/shared";
import { measureReportEntry } from "../report-math.js";

const H = 3_600_000;
const M = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9); // 09:00 UTC, a Monday

const at = (id: string, from: number, to: number, authorId = "u1"): ParallelInterval => ({
  id,
  authorId,
  startMs: T0 + from,
  endMs: T0 + to,
});

const seconds = (map: Map<string, { seconds: number }>, id: string): number | undefined => map.get(id)?.seconds;
const total = (map: Map<string, { seconds: number }>): number => [...map.values()].reduce((sum, share) => sum + share.seconds, 0);

describe("parallelShares", () => {
  it("splits two fully overlapping entries in half", () => {
    const list = [at("a", 0, H), at("b", 0, H)];
    const shares = parallelShares(list);
    assert.equal(seconds(shares, "a"), 1800);
    assert.equal(seconds(shares, "b"), 1800);
    assert.equal(total(shares), wallClockSeconds(list));
  });

  it("splits three overlapping entries into thirds", () => {
    const list = [at("a", 0, H), at("b", 0, H), at("c", 0, H)];
    const shares = parallelShares(list);
    assert.deepEqual([seconds(shares, "a"), seconds(shares, "b"), seconds(shares, "c")], [1200, 1200, 1200]);
    assert.equal(total(shares), 3600);
  });

  it("splits only the overlapping part of a partial overlap", () => {
    // a 09:00–10:00, b 09:30–10:30: the shared half hour is halved.
    const list = [at("a", 0, H), at("b", 30 * M, H + 30 * M)];
    const shares = parallelShares(list);
    assert.equal(seconds(shares, "a"), 30 * 60 + 15 * 60);
    assert.equal(seconds(shares, "b"), 15 * 60 + 30 * 60);
    assert.equal(total(shares), wallClockSeconds(list));
    assert.equal(total(shares), 90 * 60);
  });

  it("splits an entry inside another", () => {
    // a 09:00–11:00, b 09:30–10:00 inside it.
    const list = [at("a", 0, 2 * H), at("b", 30 * M, H)];
    const shares = parallelShares(list);
    assert.equal(seconds(shares, "a"), 90 * 60 + 15 * 60);
    assert.equal(seconds(shares, "b"), 15 * 60);
    assert.equal(total(shares), 2 * 3600);
  });

  it("splits a staircase of three with changing counts", () => {
    // a 0–60, b 20–80, c 40–100 (minutes). Counts: 1,2,3,2,1 over 20 min each.
    const list = [at("a", 0, 60 * M), at("b", 20 * M, 80 * M), at("c", 40 * M, 100 * M)];
    const shares = parallelShares(list);
    const third = (20 * 60) / 3;
    assert.equal(seconds(shares, "a"), Math.round(20 * 60 + 600 + third));
    assert.equal(seconds(shares, "b"), Math.round(600 + third + 600));
    assert.equal(seconds(shares, "c"), Math.round(third + 600 + 20 * 60));
    assert.equal(total(shares), wallClockSeconds(list));
  });

  it("never splits two people's time", () => {
    const shares = parallelShares([at("a", 0, H, "u1"), at("b", 0, H, "u2")]);
    assert.equal(seconds(shares, "a"), 3600);
    assert.equal(seconds(shares, "b"), 3600);
  });

  it("keeps integer seconds whose total is the wall-clock time when shares are fractional", () => {
    // Three entries over 10 seconds: 3.33… each.
    const list = [at("a", 0, 10_000), at("b", 0, 10_000), at("c", 0, 10_000)];
    const shares = parallelShares(list);
    assert.equal(total(shares), 10);
    for (const share of shares.values()) assert.ok(Number.isInteger(share.seconds));
    assert.deepEqual([...shares.values()].map((s) => s.seconds).sort(), [3, 3, 4]);
  });

  it("buckets by local day, and each day sums to that day's wall-clock time", () => {
    // Two entries 22:00–02:00 UTC across midnight.
    const start = Date.UTC(2026, 10, 2, 22);
    const list: ParallelInterval[] = [
      { id: "a", authorId: "u", startMs: start, endMs: start + 4 * H },
      { id: "b", authorId: "u", startMs: start, endMs: start + 4 * H },
    ];
    const shares = parallelShares(list, zonedDayBuckets("UTC"));
    assert.deepEqual(shares.get("a")!.slices, [
      { date: "2026-11-02", seconds: 3600 },
      { date: "2026-11-03", seconds: 3600 },
    ]);
    assert.equal(total(shares), 4 * 3600);
  });
});

describe("running timer", () => {
  it("counts a running entry up to now and splits it with what it overlaps", () => {
    const now = T0 + 2 * H;
    const window = { fromMs: T0, toMs: T0 + 24 * H };
    const running = clipInterval({ id: "r", authorId: "u", startMs: T0, endMs: null }, window, now)!;
    const done = clipInterval({ id: "d", authorId: "u", startMs: T0 + H, endMs: T0 + 2 * H }, window, now)!;
    const shares = parallelShares(overlappingIntervals([running, done]));
    assert.equal(seconds(shares, "r"), 3600 + 1800);
    assert.equal(seconds(shares, "d"), 1800);
  });
});

describe("OverlapCollector", () => {
  it("keeps only entries that overlap another of the same author, fed newest first", () => {
    const collector = new OverlapCollector();
    // Newest first: lone c, then b and a overlapping, then lone z of another author.
    for (const interval of [at("c", 5 * H, 6 * H), at("b", 30 * M, H + 30 * M), at("a", 0, H), at("z", 0, H, "u2")]) {
      collector.add(interval);
    }
    assert.deepEqual(collector.overlapping().map((i) => i.id).sort(), ["a", "b"]);
  });

  it("does not count touching entries as overlapping", () => {
    assert.deepEqual(overlappingIntervals([at("a", 0, H), at("b", H, 2 * H)]), []);
  });

  it("chains a cluster through an entry that bridges two others", () => {
    const ids = overlappingIntervals([at("a", 0, H), at("b", 50 * M, 2 * H), at("c", 110 * M, 3 * H)]).map((i) => i.id).sort();
    assert.deepEqual(ids, ["a", "b", "c"]);
  });
});

describe("report totals with parallel entries", () => {
  it("sums measured entries to the wall-clock time and splits money", () => {
    const range = { fromMs: T0 - H, toMs: T0 + 24 * H };
    const calendar = { timeZone: "UTC", weekStartsOn: 1 as const };
    const docs = [
      { id: "a", start: new Date(T0), end: new Date(T0 + H), durationSec: 3600, billable: true, hourlyRate: 100, currency: "EUR" },
      { id: "b", start: new Date(T0), end: new Date(T0 + H), durationSec: 3600, billable: false, hourlyRate: null, currency: "EUR" },
      { id: "c", start: new Date(T0 + 3 * H), end: new Date(T0 + 4 * H), durationSec: 3600, billable: false, hourlyRate: null, currency: "EUR" },
    ];
    const intervals = docs.map((doc) => clipInterval({ id: doc.id, authorId: "u", startMs: doc.start.getTime(), endMs: doc.end.getTime() }, range, T0 + 5 * H));
    const shares = parallelShares(overlappingIntervals(intervals), zonedDayBuckets("UTC"));
    assert.equal(shares.has("c"), false, "a lone entry is measured as before");
    const measured = docs.map((doc) => measureReportEntry(doc, range, T0 + 5 * H, calendar, shares.get(doc.id))!);
    assert.equal(measured.reduce((sum, m) => sum + m.seconds, 0), 2 * 3600);
    assert.equal(measured[0]!.amount, 50);
    assert.equal(measured[0]!.billableSec, 1800);
    assert.deepEqual(measured[0]!.slices, [{ date: "2026-11-02", seconds: 1800 }]);
  });
});
