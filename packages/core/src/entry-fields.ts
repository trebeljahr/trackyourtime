/**
 * What every client lets you say about a block of time.
 *
 * Six things decide what an entry *is* — its description, its client, its project, its
 * task, its tags and whether it is billable — and all six are settable from
 * every surface that creates or edits one: the tracker bar, the manual dialog,
 * an entry row, the calendar, the browser extension popup, the Raycast forms.
 * They live here rather than in any one of those because the RULES that hold
 * between them are not per-surface, and every place that reimplemented them
 * got at least one wrong.
 *
 * Client is independent of project and task. An omitted client is a legacy
 * record; explicit null means no client.
 *
 * Framework-free, like the rest of core — no React, no DOM, no tRPC.
 */

/** The fields that decide what an entry tracks. */
export type EntryFields = {
  description: string;
  clientId?: string | null;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  tagIds: string[];
};

/** A blank composer: no project, no task, no tags, not billable. */
export const emptyEntryFields = (): EntryFields => ({
  description: "",
  projectId: null,
  taskId: null,
  billable: false,
  tagIds: [],
});

/** The fields as they stand on an existing entry. */
export const entryFieldsFrom = (entry: {
  description: string;
  clientId?: string | null;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  tagIds: string[];
}): EntryFields => ({
  description: entry.description,
  ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}),
  projectId: entry.projectId,
  taskId: entry.taskId,
  billable: entry.billable,
  tagIds: [...entry.tagIds],
});

/**
 * Move an entry to another project.
 *
 * The task is deliberately left alone. A task does not belong to a project —
 * "Design review" is the same work whichever project it happens on — so
 * re-filing an entry must not throw away what it says the work WAS. The server
 * validates the two references independently, so any pair is legal.
 */
export const withProject = (
  fields: EntryFields,
  projectId: string | null,
): EntryFields =>
  projectId === fields.projectId ? fields : { ...fields, projectId };

/** Pick a task. Independent of the project, so nothing else moves. */
export const withTask = (
  fields: EntryFields,
  taskId: string | null,
): EntryFields => (taskId === fields.taskId ? fields : { ...fields, taskId });

/** Replace the whole tag set, preserving the order they were picked in. */
export const withTags = (
  fields: EntryFields,
  tagIds: readonly string[],
): EntryFields => ({ ...fields, tagIds: [...tagIds] });

/** Same ids in the same order. Tag sets are arrays, so `===` never answers. */
export const sameTagIds = (
  a: readonly string[],
  b: readonly string[],
): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Whether two field sets describe the same tracked thing. */
export const sameEntryFields = (a: EntryFields, b: EntryFields): boolean =>
  a.description === b.description &&
  a.clientId === b.clientId &&
  a.projectId === b.projectId &&
  a.taskId === b.taskId &&
  a.billable === b.billable &&
  sameTagIds(a.tagIds, b.tagIds);

const HOUR_MS = 3_600_000;

/**
 * The block a freshly opened "log past work" form offers: the hour that just
 * ended, rounded down to the minute.
 *
 * Here rather than in any one form because three surfaces open that form — the
 * web dialog, the extension popup and the Raycast command — and a default that
 * differed between them would silently change what "add an entry" means
 * depending on where it was reached from. Seconds are dropped so the times
 * read as times rather than as an instant the clock happened to be at.
 */
export const defaultManualRange = (): { start: string; end: string } => {
  const end = new Date();
  end.setSeconds(0, 0);
  return {
    start: new Date(end.getTime() - HOUR_MS).toISOString(),
    end: end.toISOString(),
  };
};
