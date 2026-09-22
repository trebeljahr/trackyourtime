// The summary timeline's per-day split across the report's groups.
//
// The year heatmap paints each day in the project that took most of it, and
// this is the one field it reads for that. The rules it needs: a day's shares
// name the same keys as `groups`, sum to the day's seconds for every
// partitioning grouping, come biggest first, and carry no money — so a caller
// whose report money is withheld still gets them.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { Types } from "mongoose";
import { reportsRouter } from "../trpc/routers/reports.js";
import type { Row } from "./support/in-memory-models.js";
import {
  ADMIN,
  ENTRY_ID,
  MEMBER,
  OWNER,
  PROJECT_ID,
  WORKSPACE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);

after(() => restore());
beforeEach(() => resetStore(store));

const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const DAY = "2026-09-07";

const OTHER_PROJECT = new Types.ObjectId("64b7f9c2e13a4d5f6a7b8c11");

/** Move the member's fixture hour onto a second project, unbillable. */
const moveMembersHourToOtherProject = (): void => {
  const row = store.entries.rows.find((entry) =>
    (entry._id as Types.ObjectId).equals(ENTRY_ID[MEMBER]),
  );
  assert.ok(row);
  row.projectId = String(OTHER_PROJECT);
  row.billable = false;
  row.project = {
    _id: OTHER_PROJECT,
    workspaceId: WORKSPACE,
    name: "Support",
    color: "#cc3300",
    clientId: null,
  };
};

const pointFor = (
  timeline: { date: string }[],
  date: string,
): Row => {
  const point = timeline.find((entry) => entry.date === date);
  assert.ok(point, `no timeline point for ${date}`);
  return point as Row;
};

describe("summary timeline shares", () => {
  it("splits a day across its projects, biggest first, keyed like the groups", async () => {
    moveMembersHourToOtherProject();
    const summary = await reportsRouter
      .createCaller(contextFor(OWNER))
      .summary({ ...RANGE, groupBy: "project" });

    const point = pointFor(summary.timeline, DAY);
    assert.equal(point.seconds, 10800);
    assert.deepEqual(point.shares, [
      { key: String(PROJECT_ID), seconds: 7200 },
      { key: String(OTHER_PROJECT), seconds: 3600 },
    ]);
    assert.deepEqual(
      summary.groups.map((group) => group.key),
      [String(PROJECT_ID), String(OTHER_PROJECT)],
    );
  });

  it("an untracked day has an empty split, never a missing one", async () => {
    const summary = await reportsRouter
      .createCaller(contextFor(OWNER))
      .summary({ ...RANGE, groupBy: "project" });
    assert.deepEqual(pointFor(summary.timeline, "2026-09-08").shares, []);
    assert.ok(summary.timeline.every((point) => Array.isArray(point.shares)));
  });

  it("follows the author scope: a closed member sees only their own hour", async () => {
    moveMembersHourToOtherProject();
    const summary = await reportsRouter
      .createCaller(contextFor(MEMBER))
      .summary({ ...RANGE, groupBy: "project" });
    assert.deepEqual(pointFor(summary.timeline, DAY).shares, [
      { key: String(OTHER_PROJECT), seconds: 3600 },
    ]);
  });

  it("survives withheld money: the split carries none", async () => {
    const summary = await reportsRouter
      .createCaller(contextFor(ADMIN))
      .summary({ ...RANGE, groupBy: "project" });
    assert.equal(summary.moneyVisible, false);
    assert.deepEqual(pointFor(summary.timeline, DAY).shares, [
      { key: String(PROJECT_ID), seconds: 10800 },
    ]);
  });
});
