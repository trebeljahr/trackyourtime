import { describe, expect, test } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { optimisticState } from "./optimistic-state";

const base = {
  activeWorkspaceId: "workspace-1",
  settings: { userId: "user-1" },
  running: { id: "running", description: "Old", start: "2026-10-01T09:00:00.000Z", end: null },
  projects: [], clients: [], tasks: [], tags: [],
  favorites: [], recents: [], quickStarts: [],
  entries: { entries: [{ id: "entry-1", description: "Old", start: "2026-10-01T09:00:00.000Z",
    end: "2026-10-01T10:00:00.000Z", durationSec: 3600 }], pendingIds: [] },
} as unknown as BackgroundState;

describe("popup optimistic snapshot", () => {
  test("patches the running timer while a worker snapshot is in flight", () => {
    const changed = optimisticState(base, { type: "timer:update", description: "New" }, "pending-1");
    expect(changed.running?.description).toBe("New");
    expect(base.running?.description).toBe("Old");
  });

  test("pins a favorite before the worker gives it an id", () => {
    const changed = optimisticState(base, { type: "favorite:add", quick: {
      description: "Work", projectId: null, taskId: null, billable: false,
    } }, "pending-2");
    expect(changed.favorites[0]?.id).toBe("pending-2");
    expect(changed.quickStarts[0]?.kind).toBe("favorite");
  });

  test("edits entries in the visible list", () => {
    const edited = optimisticState(base, { type: "entry:update", id: "entry-1",
      end: "2026-10-01T10:30:00.000Z" }, "pending-3");
    expect(edited.entries?.entries[0]?.durationSec).toBe(5400);
    expect(base.entries?.entries[0]?.durationSec).toBe(3600);
  });
});
