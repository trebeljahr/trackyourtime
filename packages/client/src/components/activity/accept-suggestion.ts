import type { DesktopActivity, DesktopActivityInterval } from "@starter/shared";

import type { ManualEntryArgs } from "@/components/tracker/use-entry-mutations";

/**
 * Turn a desktop activity suggestion into an entry, after checking it is
 * still untracked.
 *
 * The screen's list can be seconds old, and the span may have been tracked
 * since — from the tracker, the timesheet or another device. So the tracked
 * intervals around it are fetched fresh and main recomputes before anything
 * is created (the extension's accept rule):
 *
 *  - a plain accept is clipped to the untracked block it overlaps most;
 *  - an edited accept keeps the person's times, and is refused when nothing
 *    untracked overlaps them any more;
 *  - refused → nothing is created.
 *
 * The entry goes through `useEntryMutations().createManualEntry`, so it is
 * stamped `source: "desktop"`, carries the device zone and `originId`, and is
 * queued offline like any other manual entry. The span is then marked accepted
 * in main, so it is not offered again before the new entry lists.
 */

/** How far either side of the block to read what is tracked. */
export const ACCEPT_CONTEXT_MS = 12 * 60 * 60 * 1000;

/** What the entry will be filed with. `billable` undefined: the project's default. */
export type AcceptFields = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  billable?: boolean;
};

export type AcceptRequest = DesktopActivityInterval & {
  /** True when the person changed the times in the entry form. */
  edited: boolean;
  fields: AcceptFields;
};

export type AcceptOutcome =
  | { ok: true; start: number; end: number }
  | {
      ok: false;
      reason: "already-tracked" | "no-scope" | "bad-range" | "workspace-changed";
    };

/** The catalog as the cache knows it; null for a list that has not loaded. */
export type KnownCatalog = {
  projects: ReadonlyMap<string, { billableDefault: boolean }> | null;
  tasks: ReadonlySet<string> | null;
  tags: ReadonlySet<string> | null;
};

export type AcceptDeps = {
  activity: Pick<DesktopActivity, "checkAccept" | "markAccepted">;
  /** The workspace the screens address right now. */
  workspaceId: () => string | null;
  /** Everything tracked that overlaps the range, freshly read. */
  tracked: (range: DesktopActivityInterval) => Promise<DesktopActivityInterval[]>;
  catalog: () => KnownCatalog;
  createManualEntry: (args: ManualEntryArgs) => void;
  now: () => number;
};

/**
 * Drop references a rule or a stale list still carries but the catalog no
 * longer has (a deleted project, an archived-then-removed tag): the server
 * would refuse the whole entry over one of them, offline that refusal would
 * drop the queued row, and the time would be lost. An unloaded list keeps
 * what it is given.
 */
export const withKnownCatalog = (
  fields: AcceptFields,
  catalog: KnownCatalog,
): Required<AcceptFields> => {
  const projectId =
    fields.projectId !== null && catalog.projects !== null && !catalog.projects.has(fields.projectId)
      ? null
      : fields.projectId;
  const taskId =
    fields.taskId !== null && catalog.tasks !== null && !catalog.tasks.has(fields.taskId)
      ? null
      : fields.taskId;
  const tags = catalog.tags;
  const tagIds = tags === null ? fields.tagIds : fields.tagIds.filter((id) => tags.has(id));
  const billable =
    fields.billable ??
    (projectId === null ? false : (catalog.projects?.get(projectId)?.billableDefault ?? false));
  return { description: fields.description, projectId, taskId, tagIds, billable };
};

export const acceptSuggestion = async (
  request: AcceptRequest,
  deps: AcceptDeps,
): Promise<AcceptOutcome> => {
  // Captured before the first await: the entry must land in the workspace the
  // person was looking at when they pressed Add, never in one switched to
  // while the check was in flight.
  const workspaceId = deps.workspaceId();
  const now = deps.now();
  const range = {
    start: request.start - ACCEPT_CONTEXT_MS,
    end: Math.max(request.end, Math.min(now, request.end + ACCEPT_CONTEXT_MS)),
  };
  const tracked = await deps.tracked(range);
  const check = await deps.activity.checkAccept({
    start: request.start,
    end: request.end,
    edited: request.edited,
    tracked,
  });
  if (!check.ok) return check;
  if (deps.workspaceId() !== workspaceId) return { ok: false, reason: "workspace-changed" };

  const fields = withKnownCatalog(request.fields, deps.catalog());
  deps.createManualEntry({
    ...fields,
    start: new Date(check.start).toISOString(),
    end: new Date(check.end).toISOString(),
  });
  await deps.activity.markAccepted({ start: check.start, end: check.end }).catch(() => undefined);
  return { ok: true, start: check.start, end: check.end };
};
