import { describe, expect, it } from "vitest";
import type { DetailedEntry } from "@starter/shared";

import {
  EMPTY_HISTORY,
  MAX_HISTORY,
  canRedo,
  canUndo,
  draftFromEntry,
  dropStep,
  inversePatch,
  isNoopPatch,
  patchLabel,
  pushStep,
  redo,
  remapEntryId,
  replaceEntryId,
  restartsTimer,
  undo,
  type HistoryBlockReason,
  type HistoryMove,
  type HistoryState,
  type HistoryStep,
} from "./calendar-history";
import type { EntryDraft } from "./use-calendar-entries";

const entry = (overrides: Partial<DetailedEntry> = {}): DetailedEntry => ({
  id: "entry-1",
  workspaceId: "ws",
  authorId: "me",
  description: "Writing docs",
  projectId: "project-1",
  taskId: "task-1",
  billable: true,
  start: "2026-09-02T09:00:00.000Z",
  end: "2026-09-02T10:00:00.000Z",
  durationSec: 3600,
  hourlyRate: null,
  currency: "EUR",
  source: "web",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: ["tag-1"],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount: 0,
  ...overrides,
});

const DRAFT: EntryDraft = {
  description: "Writing docs",
  projectId: "project-1",
  taskId: "task-1",
  billable: true,
  start: "2026-09-02T09:00:00.000Z",
  end: "2026-09-02T10:00:00.000Z",
};

const updateStep = (id: number): HistoryStep => ({
  kind: "update",
  entryId: "entry-1",
  undo: { start: "2026-09-02T09:00:00.000Z" },
  redo: { start: "2026-09-02T11:00:00.000Z" },
  id,
  label: "move",
});

const barrierStep = (id: number, reason: HistoryBlockReason): HistoryStep => ({
  kind: "barrier",
  reason,
  id,
  label: "timeChange",
});

const createStep = (id: number, entryId: string | null): HistoryStep => ({
  kind: "create",
  entryId,
  draft: DRAFT,
  id,
  label: "create",
});

const removeStep = (id: number, entryId: string | null): HistoryStep => ({
  kind: "remove",
  entryId,
  draft: DRAFT,
  id,
  label: "delete",
});

const stacked = (...steps: HistoryStep[]): HistoryState =>
  steps.reduce(pushStep, EMPTY_HISTORY);

/** Narrow an applicable move, so a regression reads as a failed test. */
const applied = (move: HistoryMove): { step: HistoryStep; state: HistoryState } => {
  if (move.outcome !== "step") {
    throw new Error(`expected an applicable step, got ${move.outcome}`);
  }
  return { step: move.step, state: move.state };
};

describe("undo / redo ordering", () => {
  it("reports nothing to do on an empty stack", () => {
    expect(undo(EMPTY_HISTORY)).toEqual({ outcome: "empty" });
    expect(redo(EMPTY_HISTORY)).toEqual({ outcome: "empty" });
    expect(canUndo(EMPTY_HISTORY)).toBe(false);
    expect(canRedo(EMPTY_HISTORY)).toBe(false);
  });

  it("takes the newest step first and moves it onto the redo branch", () => {
    const first = applied(undo(stacked(updateStep(1), updateStep(2))));
    expect(first.step.id).toBe(2);

    const second = applied(undo(first.state));
    expect(second.step.id).toBe(1);
    expect(second.state.past).toEqual([]);
    expect(second.state.future.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it("redo replays in the order the steps were originally made", () => {
    const first = applied(undo(stacked(updateStep(1), updateStep(2))));
    const second = applied(undo(first.state));

    const replayed = applied(redo(second.state));
    expect(replayed.step.id).toBe(1);
    expect(applied(redo(replayed.state)).step.id).toBe(2);
  });

  it("a fresh action discards the redo branch", () => {
    const undone = applied(undo(stacked(updateStep(1))));
    expect(undone.state.future).toHaveLength(1);

    const next = pushStep(undone.state, updateStep(2));
    expect(next.future).toEqual([]);
    expect(next.past.map((entry) => entry.id)).toEqual([2]);
  });

  it("keeps only the newest MAX_HISTORY steps", () => {
    const many = Array.from({ length: MAX_HISTORY + 5 }, (_, index) =>
      updateStep(index + 1)
    );
    const state = stacked(...many);

    expect(state.past).toHaveLength(MAX_HISTORY);
    expect(state.past[0]?.id).toBe(6);
  });
});

describe("steps that cannot be applied", () => {
  it("stops at a barrier and says why, without consuming it", () => {
    const state = stacked(
      updateStep(1),
      barrierStep(2, "stopsRunningTimer")
    );

    const move = undo(state);
    expect(move).toEqual({ outcome: "blocked", reason: "stopsRunningTimer" });
    // The older step underneath is NOT reached — undo must never skip ahead.
    expect(state.past).toHaveLength(2);
  });

  it("waits for an in-flight create rather than deleting nothing", () => {
    const move = undo(stacked(createStep(1, null)));
    expect(move.outcome).toBe("blocked");
  });
});

describe("id remapping", () => {
  it("re-aims a create step once the server assigns an id", () => {
    const remapped = remapEntryId(stacked(createStep(1, null)), 1, "entry-9");
    expect(applied(undo(remapped)).step).toMatchObject({ entryId: "entry-9" });
  });

  it("re-aims a step sitting on the redo branch too", () => {
    const undone = applied(undo(stacked(removeStep(1, "gone"))));
    const remapped = remapEntryId(undone.state, 1, "entry-9");
    expect(remapped.future[0]).toMatchObject({ entryId: "entry-9" });
  });

  it("carries every older step about an entry to its new id", () => {
    // A move, then a delete, then the undo that re-creates it as "entry-9":
    // the move underneath has to follow, or undoing it hits a dead id.
    const state = stacked(updateStep(1), removeStep(2, "entry-1"));
    const rebased = replaceEntryId(state, "entry-1", "entry-9");

    expect(rebased.past.map((step) => ("entryId" in step ? step.entryId : null)))
      .toEqual(["entry-9", "entry-9"]);
  });

  it("leaves steps about other entries alone", () => {
    const state = stacked(removeStep(1, "entry-2"));
    expect(replaceEntryId(state, "entry-1", "entry-9").past[0]).toMatchObject({
      entryId: "entry-2",
    });
  });

  it("drops a step whose write never landed", () => {
    const state = dropStep(stacked(updateStep(1), updateStep(2)), 1);
    expect(state.past.map((entry) => entry.id)).toEqual([2]);
  });
});

describe("inverting a patch", () => {
  it("captures only the fields the patch overwrites", () => {
    expect(
      inversePatch(entry(), { start: "2026-09-02T11:00:00.000Z" })
    ).toEqual({ start: "2026-09-02T09:00:00.000Z" });
  });

  it("restores the task alongside the project", () => {
    expect(inversePatch(entry(), { projectId: "project-2" })).toEqual({
      projectId: "project-1",
      taskId: "task-1",
    });
  });

  it("round-trips a move", () => {
    const before = entry();
    const patch = {
      start: "2026-09-02T14:00:00.000Z",
      end: "2026-09-02T15:00:00.000Z",
    };
    const after = entry({ ...patch });
    expect(inversePatch(before, patch)).toEqual({
      start: before.start,
      end: before.end,
    });
    expect(inversePatch(after, inversePatch(before, patch))).toEqual(patch);
  });

  it("recognises a patch that changes nothing", () => {
    expect(isNoopPatch(entry(), { start: "2026-09-02T09:00:00.000Z" })).toBe(
      true
    );
    expect(isNoopPatch(entry(), { billable: true, description: "x" })).toBe(
      false
    );
    expect(isNoopPatch(entry(), {})).toBe(true);
  });

  // Tag sets are arrays, so identity comparison would call every re-pick a
  // change and fill the undo stack with steps that reverse nothing.
  it("compares tag sets by value", () => {
    expect(isNoopPatch(entry(), { tagIds: ["tag-1"] })).toBe(true);
    expect(isNoopPatch(entry(), { tagIds: ["tag-2"] })).toBe(false);
    expect(isNoopPatch(entry(), { tagIds: [] })).toBe(false);
  });

  it("inverts a tag change back to the set the entry carried", () => {
    const before = entry({ tagIds: ["tag-1", "tag-2"] });
    const undo = inversePatch(before, { tagIds: ["tag-3"] });
    expect(undo).toEqual({ tagIds: ["tag-1", "tag-2"] });
    // Copied, not aliased: the step outlives the cached entry it was read from.
    expect(undo.tagIds).not.toBe(before.tagIds);
  });

  it("treats an edit that stops a running timer as irreversible", () => {
    const running = entry({ end: null });
    expect(restartsTimer(running, { end: "2026-09-02T10:00:00.000Z" })).toBe(
      true
    );
    expect(restartsTimer(running, { description: "x" })).toBe(false);
    expect(restartsTimer(entry(), { end: "2026-09-02T11:00:00.000Z" })).toBe(
      false
    );
  });

  it("names the change after what it touched", () => {
    expect(
      patchLabel({
        start: "2026-09-02T09:00:00.000Z",
        end: "2026-09-02T10:00:00.000Z",
      })
    ).toBe("move");
    expect(patchLabel({ end: "2026-09-02T10:00:00.000Z" })).toBe("timeChange");
    expect(patchLabel({ description: "x" })).toBe("descriptionChange");
    expect(patchLabel({ projectId: null })).toBe("projectChange");
    expect(patchLabel({ billable: false })).toBe("billableChange");
    expect(patchLabel({ tagIds: ["tag-2"] })).toBe("tagChange");
  });
});

describe("rebuilding a deleted entry", () => {
  it("carries the fields a re-create needs, tags and zone included", () => {
    const source = entry();
    expect(draftFromEntry(source, source.end ?? "")).toEqual({
      description: "Writing docs",
      projectId: "project-1",
      taskId: "task-1",
      billable: true,
      start: "2026-09-02T09:00:00.000Z",
      end: "2026-09-02T10:00:00.000Z",
      timeZone: "Europe/Berlin",
      tagIds: ["tag-1"],
    });
  });

  it("omits an absent zone and an empty tag list", () => {
    const source = entry({ timeZone: null, tagIds: [] });
    const draft = draftFromEntry(source, source.end ?? "");
    expect(draft).not.toHaveProperty("timeZone");
    expect(draft).not.toHaveProperty("tagIds");
  });
});
