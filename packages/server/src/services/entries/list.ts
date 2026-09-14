// Reading entries: the paginated list, the "recent things" collapse, and one
// entry by id.
import mongoose, { Types, type PipelineStage } from "mongoose";
import {
  entryAmount,
  projectDetailedEntry,
  projectEntryForVisibility,
  type DetailedEntry,
  type EntryListInput,
  type RecentEntriesInput,
  type RecentEntry,
  type TimeEntry as TimeEntryWire,
  type DescriptionSuggestion,
  type EntryDescriptionsInput,
} from "@starter/shared";
import { Client, type ClientDocLike } from "../../models/Client.js";
import { Project, type ProjectDocLike } from "../../models/Project.js";
import { Task, type TaskDocLike } from "../../models/Task.js";
import {
  TimeEntry,
  toClientTimeEntry,
  type TimeEntryDocLike,
} from "../../models/TimeEntry.js";
import { authorScopeFilter } from "../../models/WorkspaceMember.js";
import { loadCatalogLookup } from "../../trpc/routers/catalog-lookup.js";
import {
  collapseDescriptions,
  collapseRecents,
  type DescriptionSourceEntry,
  type RecentSourceEntry,
} from "../../trpc/routers/quick-start.js";
import type { WorkspaceScope } from "../scope.js";
import { badRequest, escapeRegExp, notFound, requireObjectId } from "./errors.js";

const DEFAULT_LIST_LIMIT = 50;

/** How many distinct combinations `recent` answers with by default. */
const DEFAULT_RECENT_LIMIT = 8;

/** How far back `recent` looks by default. */
const DEFAULT_RECENT_DAYS = 30;

/**
 * How many entries `recent` reads before collapsing them.
 *
 * The dedup happens in this process rather than in a `$group` stage, because
 * the rules worth getting right — which of several identical jobs supplies the
 * timestamp, how an archived project is labelled, whether the running entry
 * counts — are the rules worth unit-testing, and a pipeline stage cannot be
 * tested without a database. The cap is what keeps that honest: a window this
 * size is a page, not a table scan, and `limit` distinct rows almost always
 * appear well inside it.
 */
const RECENT_SCAN_LIMIT = 400;

/** How many distinct descriptions `descriptions` answers with by default. */
const DEFAULT_DESCRIPTION_LIMIT = 25;

/**
 * How far back `descriptions` looks by default.
 *
 * Much wider than `recent`'s window, and for the opposite reason. Recents are
 * a shortlist of what you are doing *now*, so a stale row is noise. An
 * autocomplete is a memory of what you have ever called this work, so a name
 * from a quarter ago is exactly the one worth remembering for you — and it
 * costs nothing, because the user is already typing to filter it.
 */
const DEFAULT_DESCRIPTION_DAYS = 180;

type EntryAggregate = TimeEntryDocLike & {
  _id: unknown;
  project?: ProjectDocLike | null;
  client?: ClientDocLike | null;
  task?: TaskDocLike | null;
};

const toDetailedEntry = (doc: EntryAggregate): DetailedEntry => {
  const entry = toClientTimeEntry(doc);
  return {
    ...entry,
    projectName: doc.project?.name ?? null,
    projectColor: doc.project?.color ?? null,
    clientName: doc.client?.name ?? null,
    taskName: doc.task?.name ?? null,
    amount: entryAmount(entry.durationSec, entry.hourlyRate),
  };
};

/**
 * The entry list's own cursor format, kept EXACTLY as it was.
 *
 * Not `services/cursor.ts`, deliberately: cursors already in flight are the
 * one piece of state a deploy cannot migrate, and re-encoding this one would
 * make every open list page jump to the top mid-scroll. `decodeEntryCursor`
 * below still accepts a `services/cursor.ts` value, so a REST caller handed
 * one by some other route is not stuck.
 */
const encodeEntryCursor = (entry: DetailedEntry): string =>
  `${entry.start}|${entry.id}`;

type DecodedCursor = { start: Date; id: Types.ObjectId };

const decodeEntryCursor = async (
  workspaceId: string,
  cursor: string,
): Promise<DecodedCursor | null> => {
  const separator = cursor.lastIndexOf("|");
  const rawId = separator === -1 ? cursor : cursor.slice(separator + 1);
  if (!mongoose.isValidObjectId(rawId)) return null;
  const id = new Types.ObjectId(rawId);

  if (separator !== -1) {
    const startMs = Date.parse(cursor.slice(0, separator));
    if (Number.isFinite(startMs)) return { start: new Date(startMs), id };
  }

  const doc = await TimeEntry.findOne({ _id: id, workspaceId })
    .select("start")
    .lean();
  return doc ? { start: doc.start, id } : null;
};

export async function listEntries(
  scope: WorkspaceScope,
  input: EntryListInput,
): Promise<{ entries: DetailedEntry[]; nextCursor?: string }> {
  const workspaceId = scope.workspaceId;
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest("Invalid from/to range");
  }

  const conditions: Record<string, unknown>[] = [
    { workspaceId },
    // Overlap: the entry starts before the window ends and either is
    // still running or ended after the window began.
    { start: { $lt: to } },
    { $or: [{ end: null }, { end: { $gt: from } }] },
  ];

  // A member without `canViewOthersTime` sees only their own rows. Applied
  // here rather than in the UI, and to the same `$match` the aggregation
  // runs on, so there is no shape of this query that forgets it.
  const authorScope = authorScopeFilter(scope.visibility);
  if (authorScope) conditions.push(authorScope);

  let projectIds: string[] | null = input.projectIds ?? null;
  if (input.clientIds && input.clientIds.length > 0) {
    const clientProjects = await Project.find({
      workspaceId,
      clientId: { $in: input.clientIds },
    })
      .select("_id")
      .lean();
    const viaClients = clientProjects.map((project) => String(project._id));
    projectIds = projectIds
      ? projectIds.filter((id) => viaClients.includes(id))
      : viaClients;
  }
  if (projectIds) conditions.push({ projectId: { $in: projectIds } });

  if (input.taskIds) conditions.push({ taskId: { $in: input.taskIds } });

  // OR within itself, AND with everything else: an entry matches when it
  // carries ANY of the requested tags. An EMPTY array is deliberately not
  // a filter at all — it means "no tag filter", never "untagged only",
  // because that is what an untouched multi-select sends.
  if (input.tagIds && input.tagIds.length > 0) {
    conditions.push({ tagIds: { $in: input.tagIds } });
  }

  if (typeof input.billable === "boolean") {
    conditions.push({ billable: input.billable });
  }
  if (input.search && input.search.trim() !== "") {
    conditions.push({
      description: new RegExp(escapeRegExp(input.search.trim()), "i"),
    });
  }

  if (input.cursor) {
    const cursor = await decodeEntryCursor(workspaceId, input.cursor);
    if (!cursor) return { entries: [] };
    conditions.push({
      $or: [
        { start: { $lt: cursor.start } },
        { start: cursor.start, _id: { $lt: cursor.id } },
      ],
    });
  }

  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  const pipeline: PipelineStage[] = [
    { $match: { $and: conditions } },
    { $sort: { start: -1, _id: -1 } },
    { $limit: limit + 1 },
    {
      $addFields: {
        projectOid: {
          $convert: {
            input: "$projectId",
            to: "objectId",
            onError: null,
            onNull: null,
          },
        },
        taskOid: {
          $convert: {
            input: "$taskId",
            to: "objectId",
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      $lookup: {
        from: Project.collection.name,
        localField: "projectOid",
        foreignField: "_id",
        as: "projectDocs",
      },
    },
    {
      $lookup: {
        from: Task.collection.name,
        localField: "taskOid",
        foreignField: "_id",
        as: "taskDocs",
      },
    },
    {
      $addFields: {
        project: { $arrayElemAt: ["$projectDocs", 0] },
        task: { $arrayElemAt: ["$taskDocs", 0] },
      },
    },
    {
      $addFields: {
        clientOid: {
          $convert: {
            input: "$project.clientId",
            to: "objectId",
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      $lookup: {
        from: Client.collection.name,
        localField: "clientOid",
        foreignField: "_id",
        as: "clientDocs",
      },
    },
    { $addFields: { client: { $arrayElemAt: ["$clientDocs", 0] } } },
    {
      $project: {
        projectDocs: 0,
        taskDocs: 0,
        clientDocs: 0,
        projectOid: 0,
        taskOid: 0,
        clientOid: 0,
      },
    },
  ];

  const rows = await TimeEntry.aggregate<EntryAggregate>(pipeline);
  const page = rows.slice(0, limit).map(toDetailedEntry);
  const last = page[page.length - 1];

  // The value-level half of the author scope above: a colleague's row reaches
  // a member without `canViewOthersMoney` with `hourlyRate` and `amount` both
  // null. Applied in the service, not per surface, so the tracker, calendar,
  // timesheet and every REST caller receive the same projection. A row the
  // projection would drop is one the `$match` already excluded, so the page
  // size and the cursor (taken from the unprojected last row) are unchanged.
  const entries = page
    .map((entry) => projectDetailedEntry(entry, scope.visibility))
    .filter((entry): entry is DetailedEntry => entry !== null);

  return rows.length > limit && last
    ? { entries, nextCursor: encodeEntryCursor(last) }
    : { entries };
}

/**
 * The distinct things this person has recently tracked, newest first.
 *
 * Tier one of the quick-start surfaces: derived, so it costs no new model
 * and is never stale. Pinning something is what promotes it to a favorite,
 * which is tier two.
 */
export async function recentEntries(
  scope: WorkspaceScope,
  input: RecentEntriesInput,
): Promise<RecentEntry[]> {
  const workspaceId = scope.workspaceId;
  const limit = input.limit ?? DEFAULT_RECENT_LIMIT;
  const days = input.days ?? DEFAULT_RECENT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await TimeEntry.find({
    workspaceId,
    // "What have *I* recently tracked" — a quick-start list is about the
    // caller's own habits, so it is author-scoped regardless of whether
    // they may see colleagues' entries.
    authorId: scope.userId,
    start: { $gte: since },
    // Finished entries only. The running one is excluded again inside
    // `collapseRecents`; matching on it here would only waste a slot in
    // the scan window.
    end: { $ne: null },
  })
    .sort({ start: -1, _id: -1 })
    .limit(RECENT_SCAN_LIMIT)
    .select({
      description: 1,
      projectId: 1,
      taskId: 1,
      billable: 1,
      start: 1,
      end: 1,
    })
    .lean();

  const entries: RecentSourceEntry[] = rows.map((row) => ({
    id: String(row._id),
    description: row.description,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    billable: row.billable,
    start: row.start.toISOString(),
    end: row.end === null ? null : row.end.toISOString(),
  }));

  const catalog = await loadCatalogLookup(workspaceId, entries);
  return collapseRecents(entries, catalog, limit);
}

export async function getEntry(
  scope: WorkspaceScope,
  id: string,
): Promise<TimeEntryWire> {
  const entry = await TimeEntry.findOne({
    _id: requireObjectId(id, "Entry not found"),
    workspaceId: scope.workspaceId,
    ...(authorScopeFilter(scope.visibility) ?? {}),
  }).lean();
  if (!entry) throw notFound();
  // Found by the author scope, projected by the money flag: a colleague's
  // entry comes back with its rate withheld. `null` from the projection is
  // unreachable after that filter, and answers NOT_FOUND regardless — never
  // FORBIDDEN, which would confirm the id exists.
  const visible = projectEntryForVisibility(
    toClientTimeEntry(entry),
    scope.visibility,
  );
  if (!visible) throw notFound();
  return visible;
}

/**
 * Descriptions this person has used before — the autocomplete behind every
 * client's description field.
 *
 * Sibling of `recentEntries` rather than a mode of it: recents are keyed on
 * the whole (description, project, task, billable) combination and answer
 * "resume this job", while these are keyed on the description alone and
 * answer "you have called work this before". One list cannot do both without
 * either repeating a name once per project it was filed under, or hiding the
 * project a name usually belongs to.
 *
 * Author-scoped for the same reason `recentEntries` is: an autocomplete is a
 * memory of your own phrasing, not of the workspace's.
 */
export async function entryDescriptions(
  scope: WorkspaceScope,
  input: EntryDescriptionsInput,
): Promise<DescriptionSuggestion[]> {
  const workspaceId = scope.workspaceId;
  const limit = input.limit ?? DEFAULT_DESCRIPTION_LIMIT;
  const days = input.days ?? DEFAULT_DESCRIPTION_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const filter: Record<string, unknown> = {
    workspaceId,
    authorId: scope.userId,
    start: { $gte: since },
    end: { $ne: null },
    // A blank description suggests nothing, so it is excluded in the
    // query rather than scanned and thrown away — otherwise a day of
    // unnamed timers eats the whole scan window.
    description: { $nin: ["", null] },
  };

  // `undefined` is "every project"; `null` is "only unfiled entries".
  // Mongo would treat both as `{ projectId: null }` if this compared
  // loosely, which is why the check is against `undefined` by identity.
  if (input.projectId !== undefined) filter.projectId = input.projectId;
  if (input.taskId !== undefined) filter.taskId = input.taskId;

  const search = input.search?.trim() ?? "";
  if (search !== "") {
    filter.description = new RegExp(escapeRegExp(search), "i");
  }

  const rows = await TimeEntry.find(filter)
    .sort({ start: -1, _id: -1 })
    .limit(RECENT_SCAN_LIMIT)
    .select({
      description: 1,
      projectId: 1,
      taskId: 1,
      billable: 1,
      start: 1,
      end: 1,
      tagIds: 1,
    })
    .lean();

  const entries: DescriptionSourceEntry[] = rows.map((row) => ({
    id: String(row._id),
    description: row.description,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    billable: row.billable,
    start: row.start.toISOString(),
    end: row.end === null ? null : row.end.toISOString(),
    // Written before tags existed means the field is absent, not empty.
    tagIds: row.tagIds ?? [],
  }));

  const catalog = await loadCatalogLookup(workspaceId, entries);
  return collapseDescriptions(entries, catalog, limit);
}
