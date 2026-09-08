/**
 * The web client's binding for the shared optimistic-entry shapes.
 *
 * The builders themselves live in `@starter/core` so that Raycast — which
 * queues the same mutations offline and has to guess the same money snapshot —
 * cannot shape an entry differently from the tracker or the timesheet grid.
 * What stays here is the one thing core cannot know: which client this is.
 * `source` is stamped once at write time and is not backfillable, so it is
 * injected on every call rather than defaulted anywhere.
 */

import {
  buildOptimisticEntry as buildOptimisticEntryCore,
  decorateEntry as decorateEntryCore,
  projectFacts as projectFactsCore,
  stoppedEntryShape as stoppedEntryShapeCore,
  type EntryShapeContext as CoreEntryShapeContext,
  type OptimisticEntryArgs,
  type ProjectFacts,
  type ShapeableProject,
  type ShapeableTask,
} from "@starter/core";
import type { DetailedEntry, TimeEntry } from "@starter/shared";
import { entrySource } from "@/lib/entry-source";

export type { OptimisticEntryArgs, ProjectFacts, ShapeableProject, ShapeableTask };

/** Core's context minus `source`, which this module supplies. */
export type EntryShapeContext = Omit<CoreEntryShapeContext, "source">;

const withSource = (context: EntryShapeContext): CoreEntryShapeContext => ({
  ...context,
  source: entrySource(),
});

export const projectFacts = (
  context: EntryShapeContext,
  projectId: string | null
): ProjectFacts => projectFactsCore(withSource(context), projectId);

export const decorateEntry = (
  context: EntryShapeContext,
  entry: TimeEntry
): DetailedEntry => decorateEntryCore(withSource(context), entry);

export const buildOptimisticEntry = (
  context: EntryShapeContext,
  args: OptimisticEntryArgs
): DetailedEntry => buildOptimisticEntryCore(withSource(context), args);

export const stoppedEntryShape = (
  context: EntryShapeContext,
  running: TimeEntry,
  end: string
): DetailedEntry => stoppedEntryShapeCore(withSource(context), running, end);
