import { sameTagIds } from "@starter/core";
import type { DetailedEntry } from "@starter/shared";

import type { EntryDraft, EntryPatch } from "./use-calendar-entries";

/**
 * The undo model behind the calendar's Cmd/Ctrl+Z.
 *
 * A step is stored as the pair of patches that move an entry between its two
 * states, never as a snapshot of the whole calendar: a drag on Monday must not
 * be undone by restoring a cache that also throws away an unrelated edit made
 * on Tuesday, or one another device made while we were dragging.
 *
 * Everything here is pure so the ordering rules can be unit-tested without a
 * server, a socket or a rendered grid.
 */

/** How many steps are kept. Older ones fall off the bottom. */
export const MAX_HISTORY = 50;

/**
 * What a step changed, as a message key under `calendar.history.changes` —
 * never display text, so the stack reads the same in every language and the
 * words are chosen at the moment they are shown.
 */
export type HistoryChange =
  | "move"
  | "timeChange"
  | "descriptionChange"
  | "projectChange"
  | "tagChange"
  | "billableChange"
  | "edit"
  | "create"
  | "delete";

/** Why a step cannot be applied, as a key under `calendar.history.blocked`. */
export type HistoryBlockReason =
  | "stillSaving"
  | "stopsRunningTimer"
  | "deletesRunningTimer";

export type StepBody =
  | {
      kind: "update";
      entryId: string;
      /** Applied by undo — the values the entry had before the change. */
      undo: EntryPatch;
      /** Applied by redo — the values the change wrote. */
      redo: EntryPatch;
    }
  /** `entryId` is null until the server answers with the real id. */
  | { kind: "create"; entryId: string | null; draft: EntryDraft }
  | { kind: "remove"; entryId: string | null; draft: EntryDraft }
  /**
   * A change that cannot be reversed. It is recorded rather than dropped so
   * that undo stops at it and says why, instead of silently reaching past it
   * and reverting some older, unrelated change the user had forgotten about.
   */
  | { kind: "barrier"; reason: HistoryBlockReason };

/** `id` is stack-unique, so an in-flight create can find its own step again. */
export type HistoryStep = StepBody & { id: number; label: HistoryChange };

export type HistoryState = {
  past: HistoryStep[];
  future: HistoryStep[];
};

export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

/**
 * Record a step. A fresh action always discards the redo branch — redoing
 * after diverging would replay a change against an entry that has since moved.
 */
export const pushStep = (
  state: HistoryState,
  step: HistoryStep,
): HistoryState => ({
  past: [...state.past, step].slice(-MAX_HISTORY),
  future: [],
});

const replace = (
  steps: HistoryStep[],
  stepId: number,
  map: (step: HistoryStep) => HistoryStep,
): HistoryStep[] =>
  steps.map((step) => (step.id === stepId ? map(step) : step));

/**
 * Point a create/remove step at the id the server actually assigned.
 *
 * Undoing a delete re-creates the entry, which gives it a NEW id, so the step
 * that would redo that delete has to be re-aimed or it would delete nothing.
 */
export const remapEntryId = (
  state: HistoryState,
  stepId: number,
  entryId: string,
): HistoryState => ({
  past: replace(state.past, stepId, (step) =>
    step.kind === "create" || step.kind === "remove"
      ? { ...step, entryId }
      : step,
  ),
  future: replace(state.future, stepId, (step) =>
    step.kind === "create" || step.kind === "remove"
      ? { ...step, entryId }
      : step,
  ),
});

/**
 * Point EVERY step that still names `fromId` at `toId`.
 *
 * Undoing a delete re-creates the entry under a new id, which orphans every
 * older step about that same entry — the move that put it where it was, the
 * rename before that. Without this they would each undo into a "not found",
 * and one delete would quietly end the session's history.
 */
export const replaceEntryId = (
  state: HistoryState,
  fromId: string,
  toId: string,
): HistoryState => {
  const map = (step: HistoryStep): HistoryStep =>
    step.kind !== "barrier" && step.entryId === fromId
      ? { ...step, entryId: toId }
      : step;
  return { past: state.past.map(map), future: state.future.map(map) };
};

/** Forget a step whose mutation failed — there is nothing left to reverse. */
export const dropStep = (
  state: HistoryState,
  stepId: number,
): HistoryState => ({
  past: state.past.filter((step) => step.id !== stepId),
  future: state.future.filter((step) => step.id !== stepId),
});

export type HistoryMove =
  /** Apply `step`, and adopt `state`. */
  | { outcome: "step"; step: HistoryStep; state: HistoryState }
  /** Nothing to undo/redo. */
  | { outcome: "empty" }
  /** The stack is not empty but its next step cannot be applied. */
  | { outcome: "blocked"; reason: HistoryBlockReason };

/** Why a step cannot be applied right now, or null when it can. */
const blockedReason = (step: HistoryStep): HistoryBlockReason | null => {
  if (step.kind === "barrier") return step.reason;
  if ((step.kind === "create" || step.kind === "remove") && !step.entryId) {
    return "stillSaving";
  }
  return null;
};

export const undo = (state: HistoryState): HistoryMove => {
  const step = state.past[state.past.length - 1];
  if (!step) return { outcome: "empty" };

  const blocked = blockedReason(step);
  if (blocked) return { outcome: "blocked", reason: blocked };

  return {
    outcome: "step",
    step,
    state: {
      past: state.past.slice(0, -1),
      future: [step, ...state.future],
    },
  };
};

export const redo = (state: HistoryState): HistoryMove => {
  const step = state.future[0];
  if (!step) return { outcome: "empty" };

  const blocked = blockedReason(step);
  if (blocked) return { outcome: "blocked", reason: blocked };

  return {
    outcome: "step",
    step,
    state: {
      past: [...state.past, step],
      future: state.future.slice(1),
    },
  };
};

/** True when undo/redo has something applicable waiting. */
export const canUndo = (state: HistoryState): boolean => state.past.length > 0;
export const canRedo = (state: HistoryState): boolean =>
  state.future.length > 0;

/** The step undo would take next, for the button's tooltip. */
export const peekUndo = (state: HistoryState): HistoryStep | undefined =>
  state.past[state.past.length - 1];
export const peekRedo = (state: HistoryState): HistoryStep | undefined =>
  state.future[0];

// ── deriving a step from a change ────────────────────────────────────

/** Fields an `EntryPatch` can carry, so the inverse can be built key by key. */
const PATCH_FIELDS = [
  "description",
  "projectId",
  "taskId",
  "billable",
  "tagIds",
  "start",
  "end",
] as const;

/**
 * The values `entry` holds for exactly the fields `patch` overwrites.
 *
 * `projectId` drags `taskId` along with it in both directions: the server
 * rejects a task that does not belong to the entry's project, so an undo that
 * restored the project alone would either fail outright or leave the entry
 * pointing at a task from the wrong project.
 */
export const inversePatch = (
  entry: DetailedEntry,
  patch: EntryPatch,
): EntryPatch => {
  const before: EntryPatch = {};
  for (const field of PATCH_FIELDS) {
    if (patch[field] === undefined) continue;
    switch (field) {
      case "description":
        before.description = entry.description;
        break;
      case "projectId":
        before.projectId = entry.projectId;
        before.taskId = entry.taskId;
        break;
      case "taskId":
        before.taskId = entry.taskId;
        break;
      case "billable":
        before.billable = entry.billable;
        break;
      case "tagIds":
        // Copied, not aliased: the step outlives the cache entry it was read
        // from, and undo must restore the set as it was at this moment.
        before.tagIds = [...entry.tagIds];
        break;
      case "start":
        before.start = entry.start;
        break;
      case "end":
        before.end = entry.end;
        break;
    }
  }
  return before;
};

/** True when the patch would leave the entry exactly as it already is. */
export const isNoopPatch = (
  entry: DetailedEntry,
  patch: EntryPatch,
): boolean =>
  PATCH_FIELDS.every((field) => {
    const next = patch[field];
    if (next === undefined) return true;
    // Tag sets are arrays, so `===` would call every re-pick a change and fill
    // the undo stack with steps that reverse nothing.
    if (field === "tagIds") return sameTagIds(patch.tagIds ?? [], entry.tagIds);
    return next === entry[field];
  });

/**
 * Undoing an edit that stopped a running timer would have to start one again,
 * and only one entry per person may run at a time — so the undo would silently
 * stop whatever is running now. That trade is never worth making behind a
 * keystroke, so such a step becomes a barrier instead.
 */
export const restartsTimer = (
  entry: DetailedEntry,
  patch: EntryPatch,
): boolean => entry.end === null && patch.end !== undefined;

/** What the undo button and its toast call this change. */
export const patchLabel = (patch: EntryPatch): HistoryChange => {
  if (patch.start !== undefined && patch.end !== undefined) return "move";
  if (patch.start !== undefined || patch.end !== undefined) return "timeChange";
  if (patch.description !== undefined) return "descriptionChange";
  if (patch.projectId !== undefined || patch.taskId !== undefined) {
    return "projectChange";
  }
  if (patch.tagIds !== undefined) return "tagChange";
  if (patch.billable !== undefined) return "billableChange";
  return "edit";
};

/** The draft that re-creates `entry` exactly, for undoing a delete. */
export const draftFromEntry = (entry: DetailedEntry, end: string): EntryDraft => ({
  description: entry.description,
  projectId: entry.projectId,
  taskId: entry.taskId,
  billable: entry.billable,
  start: entry.start,
  end,
  ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
  ...(entry.tagIds.length > 0 ? { tagIds: [...entry.tagIds] } : {}),
});
