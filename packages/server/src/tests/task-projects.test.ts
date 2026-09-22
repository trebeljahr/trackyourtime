// The task ↔ project association the pickers suggest from. Derived, never
// stored, and read under the same author scope as the task totals.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Visibility } from "@starter/shared/types";
import {
  taskProjectPairsPipeline,
  withProjectIds,
} from "../services/catalog/task-projects.js";

const visibility = (
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Visibility => ({ userId: "me", canViewOthersTime, canViewOthersMoney });

describe("taskProjectPairsPipeline", () => {
  it("only reads entries carrying both references", () => {
    const [match] = taskProjectPairsPipeline("ws", visibility(true, true));
    const filter = (match as { $match: Record<string, unknown> }).$match;
    assert.equal(filter.workspaceId, "ws");
    assert.deepEqual(filter.taskId, { $type: "string" });
    assert.deepEqual(filter.projectId, { $type: "string" });
    assert.equal(filter.authorId, undefined);
  });

  it("is author-scoped for a member who cannot see colleagues' time", () => {
    const [match] = taskProjectPairsPipeline("ws", visibility(false, false));
    const filter = (match as { $match: Record<string, unknown> }).$match;
    assert.equal(filter.authorId, "me");
  });

  it("is author-scoped when time is visible but money is not, like the totals", () => {
    const [match] = taskProjectPairsPipeline("ws", visibility(true, false));
    const filter = (match as { $match: Record<string, unknown> }).$match;
    assert.equal(filter.authorId, "me");
  });
});

describe("withProjectIds", () => {
  it("attaches sorted project ids, and none to an unlinked task", () => {
    const links = new Map([["t1", new Set(["p2", "p1"])]]);
    assert.deepEqual(withProjectIds([{ id: "t1" }, { id: "t2" }], links), [
      { id: "t1", projectIds: ["p1", "p2"] },
      { id: "t2", projectIds: [] },
    ]);
  });
});
