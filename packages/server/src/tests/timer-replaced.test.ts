/**
 * Starting a timer in one workspace stops the one running in another — and
 * says so.
 *
 * One running entry per person across every workspace is the timer service's
 * invariant. From the workspace being looked at, the stop elsewhere is
 * invisible, so `entries.start` / `entries.continue` answer with `replaced`.
 *
 * Also: removing somebody from a workspace stops their timer THERE and nowhere
 * else (`stopRunningEntryIn`, what `members.remove` and `leave` call).
 *
 * No database: the mongoose calls the start path makes are stubbed, the same
 * handle trick as api-token-visibility.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import type { TimeEntry as TimeEntryWire } from "@starter/shared";
import { TimeEntry, type TimeEntryDocLike } from "../models/TimeEntry.js";
import { DEFAULT_WORKSPACE_SETTINGS, WorkspaceSettingsModel } from "../models/Settings.js";
import {
  personReach,
  replacedByStart,
  startTimerDetailed,
} from "../services/entries/timer.js";
import { stopRunningEntryIn } from "../services/membership/production.js";
import type { WorkspaceScope } from "../services/scope.js";

mongoose.set("bufferCommands", false);

const MIA = "u-mia";
const scopeIn = (workspaceId: string): WorkspaceScope => ({
  workspaceId,
  userId: MIA,
  visibility: { userId: MIA, canViewOthersTime: false, canViewOthersMoney: false },
});

const doc = (id: string, workspaceId: string, end: Date | null): TimeEntryDocLike => ({
  _id: id,
  workspaceId,
  authorId: MIA,
  description: "Design review",
  projectId: null,
  taskId: null,
  billable: false,
  start: new Date("2026-09-14T09:00:00.000Z"),
  end,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: "web",
  timeZone: null,
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: new Date("2026-09-14T09:00:00.000Z"),
  updatedAt: new Date("2026-09-14T09:00:00.000Z"),
});

type Lean<T> = { lean: () => Promise<T> };
const entries = TimeEntry as unknown as {
  findOne: (filter: Record<string, unknown>) => Lean<TimeEntryDocLike | null>;
  findOneAndUpdate: (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => Lean<TimeEntryDocLike | null>;
  create: (row: Record<string, unknown>) => Promise<TimeEntryDocLike>;
};
const settings = WorkspaceSettingsModel as unknown as {
  findOne: (filter: { workspaceId: string }) => Lean<Record<string, unknown>>;
};
const real = {
  findOne: entries.findOne,
  findOneAndUpdate: entries.findOneAndUpdate,
  create: entries.create,
  settingsFindOne: settings.findOne,
};

let running: TimeEntryDocLike[];
let queried: Record<string, unknown>[];

beforeEach(() => {
  running = [];
  queried = [];
  entries.findOne = (filter) => ({
    lean: async () => {
      queried.push(filter);
      return (
        running.find(
          (row) =>
            row.end === null &&
            row.authorId === filter.authorId &&
            (filter.workspaceId === undefined || row.workspaceId === filter.workspaceId),
        ) ?? null
      );
    },
  });
  entries.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const row = running.find((r) => String(r._id) === filter._id && r.end === null);
      if (!row) return null;
      Object.assign(row, update.$set);
      return { ...row };
    },
  });
  entries.create = async (row) => {
    const created = { ...(row as unknown as TimeEntryDocLike), _id: "new-entry", createdAt: new Date(), updatedAt: new Date() };
    running.push(created);
    return created;
  };
  settings.findOne = ({ workspaceId }) => ({
    lean: async () => ({ workspaceId, ...DEFAULT_WORKSPACE_SETTINGS }),
  });
});

afterEach(() => {
  entries.findOne = real.findOne;
  entries.findOneAndUpdate = real.findOneAndUpdate;
  entries.create = real.create;
  settings.findOne = real.settingsFindOne;
});

const names = async (id: string): Promise<string> => ({ "ws-a": "Acme", "ws-b": "Zeta" })[id] ?? "";

describe("entries.start — replaced", () => {
  it("starting in B while A runs stops A and reports it", async () => {
    running.push(doc("running-a", "ws-a", null));
    const started = await startTimerDetailed(scopeIn("ws-b"), { description: "x" }, personReach);
    assert.equal(started.entry.workspaceId, "ws-b");
    assert.equal(running.find((r) => r._id === "running-a")?.end instanceof Date, true);
    const replaced = await replacedByStart(started.stopped, "ws-b", names);
    assert.deepEqual(replaced, {
      entryId: "running-a",
      workspaceId: "ws-a",
      workspaceName: "Acme",
      end: started.stopped?.end,
    });
  });

  it("replacing a timer in the same workspace reports nothing", async () => {
    running.push(doc("running-b", "ws-b", null));
    const started = await startTimerDetailed(scopeIn("ws-b"), { description: "x" }, personReach);
    assert.equal(started.stopped?.id, "running-b");
    assert.equal(await replacedByStart(started.stopped, "ws-b", names), null);
  });

  it("nothing running reports nothing", async () => {
    const started = await startTimerDetailed(scopeIn("ws-b"), { description: "x" }, personReach);
    assert.equal(started.stopped, null);
    assert.equal(await replacedByStart(null, "ws-b", names), null);
  });

  it("a still-running entry is never described as replaced", async () => {
    const stillRunning = { id: "e", workspaceId: "ws-a", end: null } as unknown as TimeEntryWire;
    assert.equal(await replacedByStart(stillRunning, "ws-b", names), null);
  });
});

describe("removal stops the person's timer in that workspace only", () => {
  it("stops a timer running in the workspace they leave", async () => {
    running.push(doc("running-a", "ws-a", null));
    await stopRunningEntryIn(MIA, "ws-a");
    assert.ok(running[0]?.end instanceof Date);
    for (const filter of queried) assert.equal(filter.workspaceId, "ws-a");
  });

  it("leaves a timer running in another workspace alone", async () => {
    running.push(doc("running-b", "ws-b", null));
    await stopRunningEntryIn(MIA, "ws-a");
    assert.equal(running[0]?.end, null);
  });
});
