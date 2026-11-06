// Parallel entries through the real report router: one person's overlapping
// entries split their shared time evenly, so every total equals wall-clock
// time, while colleagues' time is summed as before.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { Types } from "mongoose";
import { reportsRouter } from "../trpc/routers/reports.js";
import {
  ENTRY_ID,
  OWNER,
  SECRET_RATE,
  WORKSPACE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);
after(restore);

const PARALLEL_ID = new Types.ObjectId("64b7f9c2e13a4d5f6a7b8d99");
const range = { from: "2026-09-01", to: "2026-09-30", timeZone: "UTC" };
const caller = () => reportsRouter.createCaller(contextFor(OWNER));

/** The owner's second entry, 09:30–10:30, overlapping their 09:00–10:00 one by half an hour. */
const addParallelEntry = (): void => {
  const template = store.entries.rows.find((row) => String(row._id) === String(ENTRY_ID[OWNER]))!;
  const start = new Date("2026-09-07T09:30:00.000Z");
  const end = new Date("2026-09-07T10:30:00.000Z");
  store.entries.rows.push({
    ...template,
    _id: PARALLEL_ID,
    description: "Second agent session",
    projectId: null,
    project: null,
    client: null,
    billable: false,
    hourlyRate: null,
    start,
    end,
    durationSec: 3600,
    createdAt: start,
    updatedAt: end,
  });
};

beforeEach(() => {
  resetStore(store);
  addParallelEntry();
});

// Fixture: owner 09:00–10:00 (billable) + 09:30–10:30 (new), admin 11–12,
// member 14–15. Owner's wall-clock time is 1.5 h; colleagues add 2 h.
const WALL_CLOCK = 3.5 * 3600;

describe("reports split parallel entries evenly", () => {
  it("summary total, groups and timeline equal wall-clock time", async () => {
    const result = await caller().summary({ ...range, groupBy: "project" });
    assert.equal(result.totalSec, WALL_CLOCK);
    assert.equal(result.groups.reduce((sum, group) => sum + group.seconds, 0), WALL_CLOCK);
    assert.equal(result.timeline.reduce((sum, point) => sum + point.seconds, 0), WALL_CLOCK);
    // The billable entry kept 45 min: 30 alone, half of the shared 30.
    assert.equal(result.billableSec, 45 * 60 + 2 * 3600);
  });

  it("splits money by the split seconds", async () => {
    const result = await caller().detailed({ ...range, limit: 50 });
    const owner = result.entries.find((entry) => entry.id === String(ENTRY_ID[OWNER]))!;
    assert.equal(owner.durationSec, 3600, "recorded time stays recorded");
    assert.equal(owner.reportedSec, 45 * 60);
    assert.equal(owner.amount, 0.75 * SECRET_RATE);
    const parallel = result.entries.find((entry) => entry.id === String(PARALLEL_ID))!;
    assert.equal(parallel.reportedSec, 45 * 60);
    assert.equal(result.totalSec, WALL_CLOCK);
  });

  it("a report filtered to one project still gives its entry only its share", async () => {
    const all = await caller().summary({ ...range, groupBy: "project" });
    const rebrand = all.groups.find((group) => group.label === "Rebrand")!;
    const filtered = await caller().summary({ ...range, groupBy: "project", projectIds: [String(store.entries.rows[0]!.projectId)] });
    assert.equal(filtered.totalSec, rebrand.seconds);
    assert.equal(filtered.totalSec, WALL_CLOCK - 45 * 60);
  });

  it("rows-only pages agree with the full detailed report", async () => {
    const full = await caller().detailed({ ...range, limit: 50 });
    let cursor: string | undefined;
    const paged: typeof full.entries = [];
    do {
      const page = await caller().rows({ ...range, limit: 1, ...(cursor ? { cursor } : {}) });
      paged.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(paged.map((entry) => entry.reportedSec), full.entries.map((entry) => entry.reportedSec));
  });

  it("weekly grid splits too", async () => {
    const result = await caller().weekly({ ...range, weekStart: "2026-09-07" });
    assert.equal(result.totalSec, WALL_CLOCK);
    assert.equal(result.dayTotals[result.days.indexOf("2026-09-07")], WALL_CLOCK);
  });

  it("never splits colleagues' time against each other", async () => {
    const admin = store.entries.rows.find((row) => row.authorId !== OWNER)!;
    admin.start = new Date("2026-09-07T09:00:00.000Z");
    admin.end = new Date("2026-09-07T10:00:00.000Z");
    const result = await caller().summary({ ...range, groupBy: "member" });
    assert.equal(result.totalSec, WALL_CLOCK);
    void WORKSPACE;
  });
});
