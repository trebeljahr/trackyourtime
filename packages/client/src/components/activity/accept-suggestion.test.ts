import { describe, expect, it, vi } from "vitest";
import type { DesktopActivityAcceptCheck, DesktopActivityInterval } from "@starter/shared";

import {
  ACCEPT_CONTEXT_MS,
  acceptSuggestion,
  withKnownCatalog,
  type AcceptDeps,
  type AcceptFields,
  type KnownCatalog,
} from "./accept-suggestion";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-22T09:00:00.000Z");

const fields: AcceptFields = {
  description: "Editor work",
  projectId: "p1",
  taskId: "t1",
  tagIds: ["g1", "g-gone"],
};

const catalog: KnownCatalog = {
  projects: new Map([["p1", { billableDefault: true }]]),
  tasks: new Set(["t1"]),
  tags: new Set(["g1"]),
};

const depsWith = (
  check: DesktopActivityAcceptCheck,
  overrides: Partial<AcceptDeps> = {},
): AcceptDeps & {
  calls: string[];
  createManualEntry: ReturnType<typeof vi.fn>;
  markAccepted: ReturnType<typeof vi.fn>;
  checkAccept: ReturnType<typeof vi.fn>;
  tracked: ReturnType<typeof vi.fn>;
} => {
  const calls: string[] = [];
  const tracked = vi.fn(async (_range: DesktopActivityInterval) => {
    calls.push("tracked");
    return [{ start: T0 - HOUR, end: T0 }];
  });
  const checkAccept = vi.fn(async () => {
    calls.push("checkAccept");
    return check;
  });
  const markAccepted = vi.fn(async () => {
    calls.push("markAccepted");
  });
  const createManualEntry = vi.fn(() => {
    calls.push("create");
  });
  return {
    calls,
    tracked,
    checkAccept,
    markAccepted,
    createManualEntry,
    activity: { checkAccept, markAccepted },
    workspaceId: () => "w1",
    catalog: () => catalog,
    now: () => T0 + 2 * HOUR,
    ...overrides,
  };
};

describe("acceptSuggestion", () => {
  it("creates the clipped span main answers with, then marks it accepted", async () => {
    const deps = depsWith({ ok: true, start: T0 + 10 * 60_000, end: T0 + HOUR });
    const outcome = await acceptSuggestion({ start: T0, end: T0 + HOUR, edited: false, fields }, deps);

    expect(outcome).toEqual({ ok: true, start: T0 + 10 * 60_000, end: T0 + HOUR });
    expect(deps.calls).toEqual(["tracked", "checkAccept", "create", "markAccepted"]);
    expect(deps.checkAccept).toHaveBeenCalledWith({
      start: T0,
      end: T0 + HOUR,
      edited: false,
      tracked: [{ start: T0 - HOUR, end: T0 }],
    });
    expect(deps.createManualEntry).toHaveBeenCalledWith({
      description: "Editor work",
      projectId: "p1",
      taskId: "t1",
      tagIds: ["g1"],
      billable: true,
      start: new Date(T0 + 10 * 60_000).toISOString(),
      end: new Date(T0 + HOUR).toISOString(),
    });
    expect(deps.markAccepted).toHaveBeenCalledWith({ start: T0 + 10 * 60_000, end: T0 + HOUR });
  });

  it("reads what is tracked around the block, up to now", async () => {
    const deps = depsWith({ ok: true, start: T0, end: T0 + HOUR });
    await acceptSuggestion({ start: T0, end: T0 + HOUR, edited: false, fields }, deps);
    expect(deps.tracked).toHaveBeenCalledWith({ start: T0 - ACCEPT_CONTEXT_MS, end: T0 + 2 * HOUR });
  });

  it("passes an edited accept through as edited, with the person's times", async () => {
    const deps = depsWith({ ok: true, start: T0 + 5 * 60_000, end: T0 + 50 * 60_000 });
    await acceptSuggestion({ start: T0 + 5 * 60_000, end: T0 + 50 * 60_000, edited: true, fields }, deps);
    expect(deps.checkAccept).toHaveBeenCalledWith(expect.objectContaining({ edited: true }));
    expect(deps.createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        start: new Date(T0 + 5 * 60_000).toISOString(),
        end: new Date(T0 + 50 * 60_000).toISOString(),
      }),
    );
  });

  it("creates nothing when main says the time is already tracked", async () => {
    const deps = depsWith({ ok: false, reason: "already-tracked" });
    const outcome = await acceptSuggestion({ start: T0, end: T0 + HOUR, edited: false, fields }, deps);
    expect(outcome).toEqual({ ok: false, reason: "already-tracked" });
    expect(deps.createManualEntry).not.toHaveBeenCalled();
    expect(deps.markAccepted).not.toHaveBeenCalled();
  });

  it("uses the workspace captured before the first await, and refuses after a switch", async () => {
    let workspace = "w1";
    const deps = depsWith(
      { ok: true, start: T0, end: T0 + HOUR },
      { workspaceId: () => workspace },
    );
    deps.tracked.mockImplementation(async () => {
      workspace = "w2";
      return [];
    });
    const outcome = await acceptSuggestion({ start: T0, end: T0 + HOUR, edited: false, fields }, deps);
    expect(outcome).toEqual({ ok: false, reason: "workspace-changed" });
    expect(deps.createManualEntry).not.toHaveBeenCalled();
  });

  it("still reports the entry when marking it accepted fails", async () => {
    const deps = depsWith({ ok: true, start: T0, end: T0 + HOUR });
    deps.markAccepted.mockRejectedValue(new Error("ipc"));
    const outcome = await acceptSuggestion({ start: T0, end: T0 + HOUR, edited: false, fields }, deps);
    expect(outcome.ok).toBe(true);
    expect(deps.createManualEntry).toHaveBeenCalledTimes(1);
  });
});

describe("withKnownCatalog", () => {
  it("drops a project, task and tags the catalog no longer has", () => {
    expect(
      withKnownCatalog(
        { description: "", projectId: "p-gone", taskId: "t-gone", tagIds: ["g1", "g-gone"] },
        catalog,
      ),
    ).toEqual({ description: "", projectId: null, taskId: null, tagIds: ["g1"], billable: false });
  });

  it("keeps everything while a list has not loaded", () => {
    expect(
      withKnownCatalog(
        { description: "", projectId: "p-x", taskId: "t-x", tagIds: ["g-x"] },
        { projects: null, tasks: null, tags: null },
      ),
    ).toEqual({ description: "", projectId: "p-x", taskId: "t-x", tagIds: ["g-x"], billable: false });
  });

  it("takes billable from the rule when it has one, else the project's default", () => {
    expect(withKnownCatalog({ ...fields, billable: false }, catalog).billable).toBe(false);
    expect(withKnownCatalog(fields, catalog).billable).toBe(true);
  });
});
