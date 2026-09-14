// IMPLEMENTED BY: reports agent
//
// Reporting is the headline feature, so the numbers have to be exactly right.
// The rules this file enforces:
//  - Every query is scoped by `workspaceId` — another workspace's data is simply not
//    there, never a FORBIDDEN.
//  - Durations are integer seconds end to end. Floats only ever appear in
//    money, and only through `entryAmount` / `sumAmounts`.
//  - Entries are CLIPPED to the reported range, so an entry straddling a
//    boundary contributes only its overlapping portion and two adjacent
//    reports never double-count it.
//  - A running entry (`end === null`) counts up to `now`.
//  - Amounts use the per-entry `hourlyRate` snapshot, never the live project
//    rate, so past earnings never shift.
//  - The `timeline` covers every day in the range with zero-filled gaps, and
//    a midnight-crossing entry is split across the days it touches — its day
//    slices always re-sum to exactly its own total, so the timeline can never
//    disagree with `totalSec`.
//  - WHICH rows a report covers is decided in `buildMatchConditions` (the
//    author scope, intersected with any `memberIds`); WHETHER it carries money
//    is decided by `reportMoneyVisible`. A report spanning colleagues' time
//    for a caller who may not see their money has every total and group
//    amount withheld as `null` — never a partial own-only sum, never zero —
//    and `moneyVisible: false` says so. Projected where honest, refused where
//    not; an amount is never recomputed at read time to fill the gap.
import { TRPCError } from "@trpc/server";
import mongoose, { Types, type PipelineStage } from "mongoose";
import {
  detailedReportSchema,
  entryAmount,
  entryDurationSec,
  exportCsvSchema,
  exportPdfSchema,
  formatDuration,
  summaryReportSchema,
  sumAmounts,
  trackedSpanSchema,
  addDaysToKey,
  dayKeyInZone,
  dayKeysBetween,
  monthKeyOf,
  projectDetailedEntry,
  reportMoneyVisible,
  resolveTimeZone,
  splitIntervalByZonedDay,
  weekStartKey,
  zonedDayStartMs,
  type DayKey,
  weeklyReportSchema,
  type CsvExportResult,
  type PdfExportResult,
  type DetailedEntry,
  type DetailedReportResult,
  type ReportFilters,
  type ReportGroupBy,
  type SummaryGroup,
  type SummaryReportResult,
  type SummaryTimelinePoint,
  type TrackedSpan,
  type Visibility,
  type WeekStart,
  type WeeklyReportResult,
  type WeeklyReportRow,
} from "@starter/shared";
import { Client, type ClientDocLike } from "../../models/Client.js";
import { Project, type ProjectDocLike } from "../../models/Project.js";
import { Tag } from "../../models/Tag.js";
import { Task, type TaskDocLike } from "../../models/Task.js";
import {
  TimeEntry,
  toClientTimeEntry,
  type TimeEntryDocLike,
} from "../../models/TimeEntry.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import {
  WorkspaceMember,
  authorScopeFilter,
} from "../../models/WorkspaceMember.js";
// The escaper is imported, never re-implemented: a second copy is one that
// eventually misses a metacharacter, and the failure is silent — a search
// pattern built from caller input reaches Mongo as a live regex, so an
// unescaped `(a+)+$` lets the caller choose how much CPU the query costs.
import { escapeRegExp } from "../../services/entries/errors.js";
import { csvFilename, toCsv, type CsvColumn, type CsvRow } from "../../services/csv.js";
import {
  renderDetailedPdf,
  renderSummaryPdf,
  renderWeeklyPdf,
  reportPdfTitle,
  type PdfReportMeta,
} from "../../services/pdf.js";
import { preferredLocale } from "../../services/user-locale.js";
import { workspaceProcedure, router } from "../trpc.js";

/**
 * Who is asking, and what they are allowed to see.
 *
 * Every report body takes this INSTEAD of a bare workspace id, so there is no
 * way to call one without having answered the visibility question. That is
 * deliberate: a report that forgets the filter does not throw, it silently
 * discloses.
 */
export type ReportScope = {
  workspaceId: string;
  visibility: Visibility;
};

const DEFAULT_DETAILED_LIMIT = 50;
const EXPORT_PAGE_SIZE = 500;
/** 200 × 500 = 100k entries — far past any real export, but bounded. */
const MAX_EXPORT_PAGES = 200;
const DAYS_PER_WEEK = 7;
/** Ten years of daily buckets — a guard against a nonsense range DoSing us. */
const MAX_TIMELINE_DAYS = 3_700;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const badRequest = (message: string): TRPCError =>
  new TRPCError({ code: "BAD_REQUEST", message });

// ── range parsing ────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A bare "YYYY-MM-DD" means a LOCAL calendar day, not UTC midnight — that is
 * how the user picked it in the date picker. A full ISO datetime is taken
 * as-is. `endOfDay` turns a date-only value into the *exclusive* upper bound
 * (local midnight of the following day).
 */
const parseRangeBound = (value: string, endOfDay: boolean): Date => {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]) + (endOfDay ? 1 : 0),
      0,
      0,
      0,
      0,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`Invalid date: ${value}`);
  }
  return parsed;
};

type Range = { from: Date; to: Date; fromMs: number; toMs: number };

const parseRange = (filters: ReportFilters): Range => {
  const from = parseRangeBound(filters.from, false);
  const to = parseRangeBound(filters.to, true);
  if (to.getTime() <= from.getTime()) {
    throw badRequest("`to` must be after `from`");
  }
  return { from, to, fromMs: from.getTime(), toMs: to.getTime() };
};

/**
 * How this report reads the calendar.
 *
 * Days, weeks and months are resolved in the CALLER's zone. Using the host's
 * own local time meant the server's zone — UTC on a deployment — so a user
 * tracking after midnight had that time filed under the previous day in every
 * report, while the tracker list (grouped in the browser) filed it under the
 * right one.
 */
type Calendar = { timeZone: string; weekStartsOn: WeekStart };

/** Every day key in `[fromMs, toMs)`, inclusive of the last partial day. */
const dayKeysInRange = (
  fromMs: number,
  toMs: number,
  timeZone: string,
): DayKey[] =>
  // `to` is exclusive: a range ending exactly at midnight must not add a day.
  dayKeysBetween(
    dayKeyInZone(fromMs, timeZone),
    dayKeyInZone(toMs - 1, timeZone),
  );


// ── filter → aggregation stages ──────────────────────────────────────

type JoinedEntry = TimeEntryDocLike & {
  _id: unknown;
  project?: ProjectDocLike | null;
  client?: ClientDocLike | null;
  task?: TaskDocLike | null;
};

/**
 * Add the author conditions — who wrote the entries a report may cover — to a
 * `$match` under construction.
 *
 * TWO conditions, each pushed on its own into the same `$and`, and never
 * merged into one. The author scope says what the caller may see; `memberIds`
 * says what they asked for. `$and` makes the result their INTERSECTION
 * structurally: a member restricted to their own rows who names a colleague
 * matches `authorId = me AND authorId IN [colleague]`, which is nothing — an
 * empty report, not an error that would confirm the colleague tracks time
 * here. Folding the two into one `$in` is how a filter comes to widen a scope.
 *
 * An empty `memberIds` is "no member filter", exactly like `tagIds`: it is
 * what an untouched multi-select sends.
 *
 * Exported for the unit tests, which evaluate the conditions against rows
 * without a database.
 */
export const pushAuthorConditions = (
  conditions: Record<string, unknown>[],
  visibility: Visibility,
  memberIds: readonly string[] | undefined,
): void => {
  const authorScope = authorScopeFilter(visibility);
  if (authorScope) conditions.push(authorScope);
  if (memberIds && memberIds.length > 0) {
    conditions.push({ authorId: { $in: [...memberIds] } });
  }
};

/**
 * Build the `$match` conditions for a report. Mirrors `entries.list`:
 * overlap semantics (the entry starts before the window ends and either is
 * still running or ended after the window began) and `clientIds` resolved to
 * project ids through the Projects collection.
 *
 * Returns `null` when the filter provably matches nothing (e.g. `clientIds`
 * that own no projects) so callers can short-circuit without a round trip.
 */
const buildMatchConditions = async (
  scope: ReportScope,
  filters: ReportFilters,
  range: Range,
): Promise<Record<string, unknown>[] | null> => {
  const { workspaceId } = scope;
  const conditions: Record<string, unknown>[] = [
    { workspaceId },
    { start: { $lt: range.to } },
    { $or: [{ end: null }, { end: { $gt: range.from } }] },
  ];

  // A member without `canViewOthersTime` is restricted to their own rows.
  // This sits in the ONE function every report body funnels its `$match`
  // through, so summary, detailed, weekly and the CSV export cannot disagree
  // about it.
  //
  // The money half — a member WITH `canViewOthersTime` but WITHOUT
  // `canViewOthersMoney` — is decided in the result projection
  // (`reportMoneyVisible`), not here, because those rows are legitimately
  // visible; it is their worth that is not.
  pushAuthorConditions(conditions, scope.visibility, filters.memberIds);

  let projectIds: string[] | null = filters.projectIds ?? null;
  if (filters.clientIds && filters.clientIds.length > 0) {
    const clientProjects = await Project.find({
      workspaceId,
      clientId: { $in: filters.clientIds },
    })
      .select("_id")
      .lean();
    const viaClients = clientProjects.map((project) => String(project._id));
    projectIds = projectIds
      ? projectIds.filter((id) => viaClients.includes(id))
      : viaClients;
  }
  if (projectIds) {
    if (projectIds.length === 0) return null;
    conditions.push({ projectId: { $in: projectIds } });
  }

  if (filters.taskIds) {
    if (filters.taskIds.length === 0) return null;
    conditions.push({ taskId: { $in: filters.taskIds } });
  }

  // Tags are OR within themselves and AND with every other filter: keep the
  // entries carrying AT LEAST ONE of the requested tags.
  //
  // Note the deliberate difference from `taskIds` two lines up: an empty
  // array here is NOT "matches nothing", it is "no tag filter". A task filter
  // is built from a picker that cannot be emptied without meaning it, while
  // the tag multi-select sends `[]` for its untouched, everything-passes
  // state — reading that as "match nothing" would blank every report the
  // moment the tag control mounted.
  if (filters.tagIds && filters.tagIds.length > 0) {
    conditions.push({ tagIds: { $in: filters.tagIds } });
  }

  if (typeof filters.billable === "boolean") {
    conditions.push({ billable: filters.billable });
  }

  if (filters.search && filters.search.trim() !== "") {
    conditions.push({
      description: new RegExp(escapeRegExp(filters.search.trim()), "i"),
    });
  }

  return conditions;
};

/**
 * `projectId` / `taskId` / `clientId` are stored as strings, so each join
 * converts to an ObjectId first (`onError: null` keeps a malformed id from
 * blowing up the whole pipeline) before the lookup.
 */
const lookupStages = (): PipelineStage[] => [
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

/**
 * The joins above match on `_id` alone, so re-assert ownership in JS: a
 * dangling or cross-owner reference must read as "no project", never leak a
 * name belonging to somebody else.
 */
const inWorkspace = <T extends { workspaceId: string }>(
  doc: T | null | undefined,
  workspaceId: string,
): T | null => (doc && doc.workspaceId === workspaceId ? doc : null);

const runJoinedQuery = async (
  workspaceId: string,
  conditions: Record<string, unknown>[],
  extraStages: PipelineStage[] = [],
): Promise<JoinedEntry[]> => {
  const pipeline: PipelineStage[] = [
    { $match: { $and: conditions } },
    { $sort: { start: -1, _id: -1 } },
    ...extraStages,
    ...lookupStages(),
  ];
  return TimeEntry.aggregate<JoinedEntry>(pipeline);
};

// ── per-entry measurement ────────────────────────────────────────────

type MeasuredEntry = {
  doc: JoinedEntry;
  /** Seconds inside the reported range — always an integer. */
  seconds: number;
  billableSec: number;
  amount: number;
  /** Local-day slices whose seconds sum to exactly `seconds`. */
  slices: { date: string; seconds: number }[];
  /** Local day the entry *started* on — the bucket for day/week/month groups. */
  /** Calendar day the entry starts on, in the caller's zone. */
  dayKey: DayKey;
};

/**
 * Clip an entry to the range, measure it, and split it across local days.
 *
 * A finished entry that sits entirely inside the range keeps its stored
 * `durationSec` (the authoritative value written on stop) rather than being
 * recomputed from timestamps, so a report can never disagree with the entry
 * list by a rounding second. The day slices are then reconciled against that
 * total so `sum(slices) === seconds` always holds.
 */
const measureEntry = (
  doc: JoinedEntry,
  range: Range,
  nowMs: number,
  calendar: Calendar,
): MeasuredEntry | null => {
  const startMs = doc.start.getTime();
  const rawEndMs = doc.end === null ? nowMs : doc.end.getTime();

  const clipStart = Math.max(startMs, range.fromMs);
  const clipEnd = Math.min(rawEndMs, range.toMs);
  if (!(clipEnd > clipStart)) return null;

  const untouched =
    doc.end !== null &&
    doc.durationSec > 0 &&
    startMs >= range.fromMs &&
    rawEndMs <= range.toMs;

  const seconds = untouched
    ? Math.round(doc.durationSec)
    : Math.max(0, Math.round((clipEnd - clipStart) / 1000));
  if (seconds <= 0) return null;

  const slices = splitIntervalByZonedDay(clipStart, clipEnd, calendar.timeZone);

  // Absorb any rounding drift into the final slice so the day series and the
  // entry total can never diverge.
  const sliced = slices.reduce((total, slice) => total + slice.seconds, 0);
  const last = slices[slices.length - 1];
  if (last && sliced !== seconds) {
    last.seconds = Math.max(0, last.seconds + (seconds - sliced));
  }

  return {
    doc,
    seconds,
    billableSec: doc.billable ? seconds : 0,
    amount: entryAmount(seconds, doc.billable ? doc.hourlyRate : null),
    slices,
    dayKey: dayKeyInZone(clipStart, calendar.timeZone),
  };
};

// ── grouping ─────────────────────────────────────────────────────────

export type GroupIdentity = { key: string; label: string; color: string | null };

const NO_PROJECT: GroupIdentity = {
  key: "none",
  label: "No project",
  color: null,
};

/**
 * The bucket for entries carrying no tags at all.
 *
 * Key `"none"` is the same convention `groupIdentity` already uses for a
 * missing project / client / task, so the client's "is this the unassigned
 * bucket?" check keeps working unchanged for tags.
 */
export const NO_TAG: GroupIdentity = {
  key: "none",
  label: "No tag",
  color: null,
};

/** Just enough of a Tag to label a group — name and color. */
export type TagLabel = { name: string; color: string };

/**
 * TAG GROUPING FANS ONE ENTRY OUT ACROSS SEVERAL GROUPS. READ THIS BEFORE
 * "FIXING" THE ARITHMETIC.
 *
 * Every other grouping in this file partitions the entries: an entry belongs
 * to exactly one project, one client, one day. Tags do not — they are
 * cross-cutting labels and an entry can carry any number of them. So a
 * two-hour entry tagged `deep-work` AND `billable-ish` contributes its FULL
 * two hours to both groups, which means:
 *
 *     sum(group.seconds) >= result.totalSec
 *
 * with equality only when no entry carries more than one tag. This is the
 * correct answer to the question people actually ask a tag report ("how much
 * time carries the `deep-work` label?"), and splitting the two hours into two
 * one-hour halves would answer nothing anybody asked.
 *
 * `totalSec` / `billableSec` / `totalAmount` are accumulated ONCE PER ENTRY,
 * outside this fan-out, so the report totals stay the true, un-double-counted
 * numbers. It is the group column that over-sums, on purpose. Any UI that
 * renders a group as a percentage of the total has to say so, or the reader
 * will assume the percentages add to 100%.
 *
 * An id with no matching tag (deleted, or belonging to somebody else) is
 * dropped rather than shown as a blank group; if that leaves the entry with
 * no tags at all it falls into {@link NO_TAG}, exactly as an untagged entry
 * does.
 */
export const tagGroupIdentities = (
  tagIds: readonly string[] | undefined,
  tags: ReadonlyMap<string, TagLabel>,
): GroupIdentity[] => {
  const identities: GroupIdentity[] = [];
  const seen = new Set<string>();

  for (const id of tagIds ?? []) {
    if (seen.has(id)) continue;
    const tag = tags.get(id);
    if (!tag) continue;
    seen.add(id);
    identities.push({ key: id, label: tag.name, color: tag.color });
  }

  return identities.length > 0 ? identities : [NO_TAG];
};

/** The label an author with no membership in the workspace is grouped under. */
export const FORMER_MEMBER_LABEL = "Former member";

/** The label a current member with no name anywhere is grouped under. */
export const UNNAMED_MEMBER_LABEL = "Unnamed member";

/**
 * Display names for a member-grouped report, keyed by author id.
 *
 * Resolution order, per author:
 *
 *  1. the LIVE `user` record's name — a rename shows up in the next report
 *     rather than waiting for a denormalized copy to be refreshed;
 *  2. the name mirrored onto `WorkspaceMember`, for a user record that is
 *     missing or nameless;
 *  3. {@link FORMER_MEMBER_LABEL} for an author with no membership at all —
 *     somebody who left or was removed. Their history still counts, but a
 *     report is not where a departed person's name keeps being published.
 *
 * Pure so the fallback chain is testable without either collection. Only
 * ever called with authors of rows the caller may already see, because the
 * ids come off the matched documents — so it cannot name a colleague to a
 * member restricted to their own time.
 */
export const resolveMemberLabels = (
  authorIds: Iterable<string>,
  memberships: ReadonlyMap<string, { name: string }>,
  userNames: ReadonlyMap<string, string>,
): Map<string, string> => {
  const labels = new Map<string, string>();
  for (const authorId of authorIds) {
    const membership = memberships.get(authorId);
    if (!membership) {
      labels.set(authorId, FORMER_MEMBER_LABEL);
      continue;
    }
    const live = userNames.get(authorId)?.trim() ?? "";
    const mirrored = membership.name.trim();
    labels.set(authorId, live || mirrored || UNNAMED_MEMBER_LABEL);
  }
  return labels;
};

/**
 * Read the two sources {@link resolveMemberLabels} decides between.
 *
 * The `user` collection belongs to better-auth, which keys it by ObjectId
 * while every app collection stores the id as a string; ids that are not
 * ObjectIds (none today) simply resolve through the membership name. A user
 * read that fails is not fatal — a report is still right without names —
 * so it degrades to the membership mirror.
 */
const loadMemberLabels = async (
  workspaceId: string,
  authorIds: readonly string[],
): Promise<Map<string, string>> => {
  if (authorIds.length === 0) return new Map();

  const members = await WorkspaceMember.find({
    workspaceId,
    userId: { $in: [...authorIds] },
  })
    .select({ userId: 1, name: 1 })
    .lean();
  const memberships = new Map(
    members.map((member) => [member.userId, { name: member.name ?? "" }]),
  );

  const userNames = new Map<string, string>();
  const objectIds = authorIds
    .filter((id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(id))
    .map((id) => new Types.ObjectId(id));
  const db = mongoose.connection.db;
  if (db && objectIds.length > 0) {
    try {
      const users = await db
        .collection<{ _id: Types.ObjectId; name?: unknown }>("user")
        .find({ _id: { $in: objectIds } }, { projection: { name: 1 } })
        .toArray();
      for (const user of users) {
        if (typeof user.name === "string") {
          userNames.set(String(user._id), user.name);
        }
      }
    } catch {
      // Names are presentation; the membership mirror still labels the group.
    }
  }

  return resolveMemberLabels(authorIds, memberships, userNames);
};

const groupIdentity = (
  measured: MeasuredEntry,
  // "tag" is excluded on purpose: it is the one grouping that cannot produce
  // ONE identity per entry, so it never reaches this function — see
  // `tagGroupIdentities`. Excluding it here keeps the switch below exhaustive
  // without a lying placeholder arm.
  groupBy: Exclude<ReportGroupBy, "tag">,
  workspaceId: string,
  calendar: Calendar,
  memberLabels: ReadonlyMap<string, string>,
): GroupIdentity => {
  const { doc } = measured;
  const project = inWorkspace(doc.project, workspaceId);
  const client = inWorkspace(doc.client, workspaceId);
  const task = inWorkspace(doc.task, workspaceId);

  switch (groupBy) {
    case "member":
      return {
        key: doc.authorId,
        label: memberLabels.get(doc.authorId) ?? FORMER_MEMBER_LABEL,
        color: null,
      };

    case "project":
      return project
        ? { key: String(project._id), label: project.name, color: project.color }
        : NO_PROJECT;

    case "client":
      return client
        ? { key: String(client._id), label: client.name, color: client.color }
        : { key: "none", label: "No client", color: null };

    case "task":
      return task
        ? {
            key: String(task._id),
            label: task.name,
            color: project?.color ?? null,
          }
        : { key: "none", label: "No task", color: null };

    case "day": {
      const key = measured.dayKey;
      return { key, label: key, color: null };
    }

    case "week": {
      const key = weekStartKey(measured.dayKey, calendar.weekStartsOn);
      const weekEnd = addDaysToKey(key, DAYS_PER_WEEK - 1);
      return { key, label: `${key} – ${weekEnd}`, color: null };
    }

    case "month": {
      const key = monthKeyOf(measured.dayKey);
      const month = Number(key.slice(5, 7)) - 1;
      const year = key.slice(0, 4);
      return {
        key,
        label: `${MONTH_NAMES[month] ?? key} ${year}`,
        color: null,
      };
    }
  }
};

export type GroupAccumulator = GroupIdentity & {
  seconds: number;
  billableSec: number;
  amounts: number[];
};

/** What one measured entry contributes to whichever groups it lands in. */
export type GroupContribution = {
  seconds: number;
  billableSec: number;
  amount: number;
};

/**
 * Add one entry's numbers to every group it belongs to.
 *
 * For the partitioning groupings `identities` always holds exactly one entry
 * and this is a plain accumulate. For `groupBy: "tag"` it holds one per tag,
 * and the entry's seconds land in each of them — see `tagGroupIdentities` for
 * why that is the intended arithmetic rather than double counting.
 */
export const accumulateGroups = (
  groups: Map<string, GroupAccumulator>,
  identities: readonly GroupIdentity[],
  contribution: GroupContribution,
): void => {
  for (const identity of identities) {
    const group = groups.get(identity.key) ?? {
      ...identity,
      seconds: 0,
      billableSec: 0,
      amounts: [],
    };
    group.seconds += contribution.seconds;
    group.billableSec += contribution.billableSec;
    if (contribution.amount !== 0) group.amounts.push(contribution.amount);
    groups.set(identity.key, group);
  }
};

/** Biggest first, ties broken by key so the order is stable across calls. */
export const sortGroups = (
  groups: Iterable<GroupAccumulator>,
): SummaryGroup[] =>
  [...groups]
    .map(({ key, label, color, seconds, billableSec, amounts }) => ({
      key,
      label,
      color,
      seconds,
      billableSec,
      amount: sumAmounts(amounts),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));

// ── report bodies (shared by the queries and by exportCsv) ───────────

const emptySummary = (
  currency: string,
  range: Range,
  timeZone: string,
  moneyVisible: boolean,
): SummaryReportResult => ({
  totalSec: 0,
  billableSec: 0,
  totalAmount: moneyVisible ? 0 : null,
  currency,
  groups: [],
  timeline: dayKeysInRange(range.fromMs, range.toMs, timeZone).map((date) => ({
    date,
    seconds: 0,
    billableSec: 0,
  })),
  moneyVisible,
});

/**
 * A summary as a caller whose report money is withheld may receive it.
 *
 * EVERY amount goes, including a group that happens to hold only the caller's
 * own entries (their own member group, a project nobody else booked): which
 * groups are "safe" is itself a statement about colleagues' work, and a
 * report where some amounts are real and some are dashes invites exactly the
 * subtraction the dashes exist to prevent. Seconds stay — time is what this
 * caller may see.
 *
 * Exported for the unit tests.
 */
export const withholdSummaryMoney = (
  result: SummaryReportResult,
): SummaryReportResult => ({
  ...result,
  totalAmount: null,
  groups: result.groups.map((group) => ({ ...group, amount: null })),
  moneyVisible: false,
});

/**
 * A detailed page as a caller may receive it. Every row goes through
 * `projectDetailedEntry` — the same projection `entries.list` and REST apply.
 *
 * When the report's money is withheld, the caller's OWN rows lose their rate
 * and amount too, for the reason `withholdSummaryMoney` gives: a report is
 * one document with one answer to "does this carry money", and a page where
 * some amounts are real and some are dashes is a page of subtraction
 * exercises. The CSV and PDF exports drop the money columns for the same
 * caller, so the three renderings of one report cannot disagree. (The entry
 * list is a different document and keeps the caller's own rates.)
 *
 * Exported for the unit tests.
 */
export const projectDetailedReport = (
  result: DetailedReportResult,
  visibility: Visibility,
): DetailedReportResult => {
  const entries = result.entries
    .map((entry) => projectDetailedEntry(entry, visibility))
    .filter((entry): entry is DetailedEntry => entry !== null);
  if (reportMoneyVisible(visibility)) {
    return { ...result, entries, moneyVisible: true };
  }
  return {
    ...result,
    entries: entries.map((entry) => ({ ...entry, hourlyRate: null, amount: null })),
    totalAmount: null,
    moneyVisible: false,
  };
};

/**
 * Exported for the public REST API, which calls these directly rather than
 * through tRPC. NOT extracted into `services/`: `buildMatchConditions` is the
 * one funnel every report's `$match` goes through, and moving 1200 lines to
 * gain an import path is how a funnel acquires a second entrance.
 * `WorkspaceScope` is structurally assignable to {@link ReportScope}.
 */
export const buildSummary = async (
  scope: ReportScope,
  filters: ReportFilters,
  groupBy: ReportGroupBy,
): Promise<SummaryReportResult> => {
  const { workspaceId } = scope;
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const range = parseRange(filters);
  const nowMs = Date.now();
  const calendar: Calendar = {
    timeZone: resolveTimeZone(filters.timeZone),
    weekStartsOn: settings.weekStartsOn,
  };

  const moneyVisible = reportMoneyVisible(scope.visibility);
  const conditions = await buildMatchConditions(scope, filters, range);
  if (conditions === null)
    return emptySummary(settings.currency, range, calendar.timeZone, moneyVisible);

  const docs = await runJoinedQuery(workspaceId, conditions);

  // Names for a member grouping come from the authors of the MATCHED rows,
  // never from the workspace's member list: a caller who may see only their
  // own time learns their own name and nothing else.
  const memberLabels =
    groupBy === "member"
      ? await loadMemberLabels(workspaceId, [
          ...new Set(docs.map((doc) => doc.authorId)),
        ])
      : new Map<string, string>();

  // Tag labels come from ONE query, not from a join per entry: the tag list is
  // small, bounded by the workspace's own catalog, and every entry in the report
  // draws its labels from the same table. Archived tags are included on
  // purpose — an archived tag still labels the history it was applied to, and
  // dropping it would move that time into "No tag".
  const tagIndex = new Map<string, TagLabel>();
  if (groupBy === "tag") {
    const tags = await Tag.find({ workspaceId })
      .select("name color")
      .lean();
    for (const tag of tags) {
      tagIndex.set(String(tag._id), { name: tag.name, color: tag.color });
    }
  }

  const timeline = new Map<string, SummaryTimelinePoint>();
  for (const date of dayKeysInRange(range.fromMs, range.toMs, calendar.timeZone)) {
    timeline.set(date, { date, seconds: 0, billableSec: 0 });
  }

  const groups = new Map<string, GroupAccumulator>();
  let totalSec = 0;
  let billableSec = 0;
  const amounts: number[] = [];

  for (const doc of docs) {
    const measured = measureEntry(doc, range, nowMs, calendar);
    if (!measured) continue;

    // ONCE per entry, whatever the grouping — these are the true totals and
    // must not inherit the tag fan-out's deliberate over-count.
    totalSec += measured.seconds;
    billableSec += measured.billableSec;
    if (measured.amount !== 0) amounts.push(measured.amount);

    const identities =
      groupBy === "tag"
        ? tagGroupIdentities(measured.doc.tagIds, tagIndex)
        : [
            groupIdentity(
              measured,
              groupBy,
              workspaceId,
              calendar,
              memberLabels,
            ),
          ];

    accumulateGroups(groups, identities, {
      seconds: measured.seconds,
      billableSec: measured.billableSec,
      amount: measured.amount,
    });

    for (const slice of measured.slices) {
      // A slice can fall outside the timeline only if the clip math and the
      // day enumeration disagree; skip rather than invent a bucket.
      const point = timeline.get(slice.date);
      if (!point) continue;
      point.seconds += slice.seconds;
      if (doc.billable) point.billableSec += slice.seconds;
    }
  }

  const sortedGroups: SummaryGroup[] = sortGroups(groups.values());

  const result: SummaryReportResult = {
    totalSec,
    billableSec,
    totalAmount: sumAmounts(amounts),
    currency: settings.currency,
    groups: sortedGroups,
    timeline: [...timeline.values()],
    moneyVisible: true,
  };
  return moneyVisible ? result : withholdSummaryMoney(result);
};

const encodeCursor = (start: Date, id: string): string =>
  `${start.toISOString()}|${id}`;

type DecodedCursor = { start: Date; id: Types.ObjectId };

const decodeCursor = (cursor: string): DecodedCursor | null => {
  const separator = cursor.lastIndexOf("|");
  if (separator === -1) return null;
  const rawId = cursor.slice(separator + 1);
  if (!mongoose.isValidObjectId(rawId)) return null;
  const startMs = Date.parse(cursor.slice(0, separator));
  if (!Number.isFinite(startMs)) return null;
  return { start: new Date(startMs), id: new Types.ObjectId(rawId) };
};

const toDetailedEntry = (
  measured: MeasuredEntry,
  workspaceId: string,
): DetailedEntry => {
  const { doc } = measured;
  const project = inWorkspace(doc.project, workspaceId);
  const client = inWorkspace(doc.client, workspaceId);
  const task = inWorkspace(doc.task, workspaceId);

  return {
    ...toClientTimeEntry(doc),
    projectName: project?.name ?? null,
    projectColor: project?.color ?? null,
    clientName: client?.name ?? null,
    taskName: task?.name ?? null,
    amount: measured.amount,
  };
};

export const buildDetailed = async (
  scope: ReportScope,
  filters: ReportFilters,
  page: { cursor?: string; limit?: number },
  /**
   * Range totals cost a full scan of the filtered set. The CSV export walks
   * every page, so it asks for them once and skips them on subsequent pages.
   */
  withTotals = true,
): Promise<DetailedReportResult> => {
  const { workspaceId } = scope;
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const range = parseRange(filters);
  const nowMs = Date.now();
  const limit = page.limit ?? DEFAULT_DETAILED_LIMIT;

  const conditions = await buildMatchConditions(scope, filters, range);
  if (conditions === null) {
    return projectDetailedReport(
      {
        entries: [],
        totalSec: 0,
        totalAmount: 0,
        currency: settings.currency,
        moneyVisible: true,
      },
      scope.visibility,
    );
  }

  // Range totals cover the WHOLE filtered set, not the current page — a
  // paginated total would be a lie on every page but the last.
  const allMatching = withTotals
    ? await TimeEntry.find({ $and: conditions })
        .select("start end durationSec billable hourlyRate")
        .lean()
    : [];

  let totalSec = 0;
  const amounts: number[] = [];
  for (const entry of allMatching) {
    const startMs = entry.start.getTime();
    const rawEndMs = entry.end === null ? nowMs : entry.end.getTime();
    const clipStart = Math.max(startMs, range.fromMs);
    const clipEnd = Math.min(rawEndMs, range.toMs);
    if (!(clipEnd > clipStart)) continue;

    const untouched =
      entry.end !== null &&
      entry.durationSec > 0 &&
      startMs >= range.fromMs &&
      rawEndMs <= range.toMs;
    const seconds = untouched
      ? Math.round(entry.durationSec)
      : Math.max(0, Math.round((clipEnd - clipStart) / 1000));
    if (seconds <= 0) continue;

    totalSec += seconds;
    const amount = entryAmount(seconds, entry.billable ? entry.hourlyRate : null);
    if (amount !== 0) amounts.push(amount);
  }

  const pageConditions = [...conditions];
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor);
    if (!cursor) throw badRequest("Invalid cursor");
    pageConditions.push({
      $or: [
        { start: { $lt: cursor.start } },
        { start: cursor.start, _id: { $lt: cursor.id } },
      ],
    });
  }

  const docs = await runJoinedQuery(workspaceId, pageConditions, [
    { $limit: limit + 1 },
  ]);

  const window = docs.slice(0, limit);
  const entries = window
    .map((doc) =>
      measureEntry(doc, range, nowMs, {
        timeZone: resolveTimeZone(filters.timeZone),
        weekStartsOn: settings.weekStartsOn,
      }),
    )
    .filter((measured): measured is MeasuredEntry => measured !== null)
    .map((measured) => toDetailedEntry(measured, workspaceId));

  const lastDoc = window[window.length - 1];
  const nextCursor =
    docs.length > limit && lastDoc
      ? encodeCursor(lastDoc.start, String(lastDoc._id))
      : undefined;

  return projectDetailedReport(
    {
      entries,
      ...(nextCursor ? { nextCursor } : {}),
      totalSec,
      totalAmount: sumAmounts(amounts),
      currency: settings.currency,
      moneyVisible: true,
    },
    scope.visibility,
  );
};

export const buildWeekly = async (
  scope: ReportScope,
  filters: ReportFilters,
  weekStart: string,
): Promise<WeeklyReportResult> => {
  const { workspaceId } = scope;
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const nowMs = Date.now();
  const calendar: Calendar = {
    timeZone: resolveTimeZone(filters.timeZone),
    weekStartsOn: settings.weekStartsOn,
  };

  // The week window is authoritative for the date range; `from`/`to` on the
  // filters only bound which week the caller may ask for. The grid must always
  // be exactly seven days wide starting at `weekStart`.
  const firstKey = dayKeyInZone(
    parseRangeBound(weekStart, false).getTime(),
    calendar.timeZone,
  );
  const days: DayKey[] = [];
  for (let index = 0; index < DAYS_PER_WEEK; index += 1) {
    days.push(addDaysToKey(firstKey, index));
  }

  // The grid's window is the seven zoned days themselves, so a week is exactly
  // the time between local midnights — 167 or 169 hours across a DST shift.
  const fromMs = zonedDayStartMs(firstKey, calendar.timeZone);
  const toMs = zonedDayStartMs(
    addDaysToKey(firstKey, DAYS_PER_WEEK),
    calendar.timeZone,
  );
  const range: Range = {
    from: new Date(fromMs),
    to: new Date(toMs),
    fromMs,
    toMs,
  };
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const dayTotals = days.map(() => 0);

  const moneyVisible = reportMoneyVisible(scope.visibility);
  const conditions = await buildMatchConditions(scope, filters, range);
  if (conditions === null) {
    return { days, rows: [], dayTotals, totalSec: 0, moneyVisible };
  }

  const docs = await runJoinedQuery(workspaceId, conditions);

  const rows = new Map<string, WeeklyReportRow>();
  let totalSec = 0;

  for (const doc of docs) {
    const measured = measureEntry(doc, range, nowMs, calendar);
    if (!measured) continue;

    const project = inWorkspace(doc.project, workspaceId);
    const task = inWorkspace(doc.task, workspaceId);
    const projectId = project ? String(project._id) : null;
    const taskId = task ? String(task._id) : null;
    const rowKey = `${projectId ?? ""}::${taskId ?? ""}`;
    const projectLabel = project?.name ?? NO_PROJECT.label;

    const row = rows.get(rowKey) ?? {
      projectId,
      taskId,
      label: task ? `${projectLabel} – ${task.name}` : projectLabel,
      color: project?.color ?? null,
      daySeconds: days.map(() => 0),
      totalSec: 0,
    };

    for (const slice of measured.slices) {
      const index = dayIndex.get(slice.date);
      if (index === undefined) continue;
      row.daySeconds[index] = (row.daySeconds[index] ?? 0) + slice.seconds;
      dayTotals[index] = (dayTotals[index] ?? 0) + slice.seconds;
      row.totalSec += slice.seconds;
      totalSec += slice.seconds;
    }

    rows.set(rowKey, row);
  }

  const sortedRows = [...rows.values()]
    .filter((row) => row.totalSec > 0)
    .sort((a, b) => b.totalSec - a.totalSec || a.label.localeCompare(b.label));

  return { days, rows: sortedRows, dayTotals, totalSec, moneyVisible };
};

// ── CSV serialization ────────────────────────────────────────────────

/** Hours as a decimal, 2dp — what people paste into an invoice. */
const decimalHours = (seconds: number): number =>
  Math.round((seconds / 3600) * 100) / 100;

/**
 * The money columns of the report CSVs. A file is not a page: once it has
 * left the machine there is no dash to explain a blank, and a blank Amount
 * column sums to zero in every spreadsheet. So when a report's money is
 * withheld the COLUMNS go, not merely the values — the header set itself says
 * "this export carries no money".
 */
const MONEY_CSV_KEYS: ReadonlySet<string> = new Set(["rate", "amount", "currency"]);

const withoutMoneyColumns = (
  columns: readonly CsvColumn[],
  moneyVisible: boolean,
): CsvColumn[] =>
  moneyVisible
    ? [...columns]
    : columns.filter((column) => !MONEY_CSV_KEYS.has(column.key));

const ALL_SUMMARY_COLUMNS: readonly CsvColumn[] = [
  { key: "label", header: "Group" },
  { key: "duration", header: "Duration" },
  { key: "hours", header: "Hours" },
  { key: "seconds", header: "Seconds" },
  { key: "billableHours", header: "Billable hours" },
  { key: "billableSeconds", header: "Billable seconds" },
  { key: "amount", header: "Amount" },
  { key: "currency", header: "Currency" },
];

/** The summary CSV header set for a report whose money is or is not visible. */
export const summaryCsvColumns = (moneyVisible: boolean): CsvColumn[] =>
  withoutMoneyColumns(ALL_SUMMARY_COLUMNS, moneyVisible);

/** Exported for the unit tests. */
export const summaryCsvRows = (result: SummaryReportResult): CsvRow[] =>
  result.groups.map((group) => ({
    label: group.label,
    duration: formatDuration(group.seconds, "hms"),
    hours: decimalHours(group.seconds),
    seconds: group.seconds,
    billableHours: decimalHours(group.billableSec),
    billableSeconds: group.billableSec,
    // Not written at all when withheld. The column is dropped too, but a row
    // that never held the value cannot leak it through a later column change.
    ...(result.moneyVisible
      ? { amount: group.amount, currency: result.currency }
      : {}),
  }));

const ALL_DETAILED_COLUMNS: readonly CsvColumn[] = [
  { key: "date", header: "Date" },
  { key: "start", header: "Start" },
  { key: "end", header: "End" },
  { key: "duration", header: "Duration" },
  { key: "hours", header: "Hours" },
  { key: "seconds", header: "Seconds" },
  { key: "description", header: "Description" },
  { key: "project", header: "Project" },
  { key: "client", header: "Client" },
  { key: "task", header: "Task" },
  { key: "billable", header: "Billable" },
  { key: "rate", header: "Rate" },
  { key: "amount", header: "Amount" },
  { key: "currency", header: "Currency" },
  { key: "source", header: "Source" },
  { key: "id", header: "Id" },
];

/** The detailed CSV header set for a report whose money is or is not visible. */
export const detailedCsvColumns = (moneyVisible: boolean): CsvColumn[] =>
  withoutMoneyColumns(ALL_DETAILED_COLUMNS, moneyVisible);

/** Exported for the unit tests. */
export const detailedCsvRows = (
  result: DetailedReportResult,
  timeZone: string,
): CsvRow[] => {
  const nowMs = Date.now();
  return result.entries.map((entry) => {
    const seconds = entryDurationSec(entry, nowMs);
    const money: CsvRow = result.moneyVisible
      ? { rate: entry.hourlyRate, amount: entry.amount, currency: entry.currency }
      : {};
    return {
      ...money,
      date: dayKeyInZone(Date.parse(entry.start), timeZone),
      start: entry.start,
      end: entry.end,
      duration: formatDuration(seconds, "hms"),
      hours: decimalHours(seconds),
      seconds,
      description: entry.description,
      project: entry.projectName,
      client: entry.clientName,
      task: entry.taskName,
      billable: entry.billable ? "yes" : "no",
      source: entry.source,
      id: entry.id,
    };
  });
};

const weeklyCsvColumns = (result: WeeklyReportResult): CsvColumn[] => [
  { key: "label", header: "Project / Task" },
  ...result.days.map((day) => ({ key: `day:${day}`, header: day })),
  { key: "total", header: "Total" },
];

const weeklyCsvRows = (result: WeeklyReportResult): CsvRow[] =>
  result.rows.map((row) => {
    const csvRow: CsvRow = {
      label: row.label,
      total: decimalHours(row.totalSec),
    };
    result.days.forEach((day, index) => {
      csvRow[`day:${day}`] = decimalHours(row.daySeconds[index] ?? 0);
    });
    return csvRow;
  });

/** The CSV filename carries the range so a folder of exports stays readable. */
const exportFilename = (
  report: string,
  range: Range,
  timeZone: string,
): string =>
  csvFilename(
    report,
    dayKeyInZone(range.fromMs, timeZone),
    dayKeyInZone(range.toMs - 1, timeZone),
  );

/**
 * Same name, different extension. `csvFilename` hard-codes ".csv", so this
 * swaps the suffix rather than duplicating the sanitising rules — one place
 * decides what characters survive into a filename.
 */
const pdfFilename = (
  report: string,
  range: Range,
  timeZone: string,
): string => `${exportFilename(report, range, timeZone).replace(/\.csv$/, "")}.pdf`;

type CsvExport = CsvExportResult & { mimeType: "text/csv" };

// ── router ───────────────────────────────────────────────────────────

/**
 * The first and last day this scope has tracked time on.
 *
 * The upper bound is `max(last end, last start, today)`: `$max` skips the
 * `null` end of a running entry, and a manually filed entry can sit in the
 * future, so neither the last end nor the last start alone bounds the data.
 * Today is always a sensible range end, so folding it in costs nothing.
 */
const buildTrackedSpan = async (
  scope: ReportScope,
  timeZone: string,
  memberIds: readonly string[] | undefined,
): Promise<TrackedSpan> => {
  const conditions: Record<string, unknown>[] = [
    { workspaceId: scope.workspaceId },
  ];
  // The same author conditions as every report, so "all time" for a member
  // filter spans that member's history and never a colleague's the caller
  // may not see.
  pushAuthorConditions(conditions, scope.visibility, memberIds);

  const [span] = await TimeEntry.aggregate<{
    first: Date | null;
    lastStart: Date | null;
    lastEnd: Date | null;
  }>([
    { $match: { $and: conditions } },
    {
      $group: {
        _id: null,
        first: { $min: "$start" },
        lastStart: { $max: "$start" },
        lastEnd: { $max: "$end" },
      },
    },
  ]);

  if (!span || span.first === null) return { from: null, to: null };

  const lastMs = Math.max(
    span.lastEnd?.getTime() ?? 0,
    span.lastStart?.getTime() ?? 0,
    Date.now(),
  );

  return {
    from: dayKeyInZone(span.first.getTime(), timeZone),
    to: dayKeyInZone(lastMs, timeZone),
  };
};

/**
 * Lift the request context into a report scope.
 *
 * Both fields come from the workspace middleware, which resolved them once.
 * Nothing here re-derives visibility from a role or an input flag.
 */
const reportScope = (ctx: {
  workspaceId: string;
  visibility: Visibility;
}): ReportScope => ({
  workspaceId: ctx.workspaceId,
  visibility: ctx.visibility,
});

export const reportsRouter = router({
  /** Totals, grouped breakdown and a zero-filled daily series for charts. */
  summary: workspaceProcedure
    .input(summaryReportSchema)
    .query(async ({ ctx, input }): Promise<SummaryReportResult> => {
      return buildSummary(reportScope(ctx), input, input.groupBy);
    }),

  /**
   * The days this workspace's tracked time actually spans — what an "all
   * time" range resolves to. Cheap enough to sit behind every catalog row's
   * "show time entries" link.
   */
  trackedSpan: workspaceProcedure
    .input(trackedSpanSchema)
    .query(async ({ ctx, input }): Promise<TrackedSpan> => {
      return buildTrackedSpan(
        reportScope(ctx),
        resolveTimeZone(input.timeZone),
        input.memberIds,
      );
    }),

  /** Flat, paginated entry log; totals always span the full filtered range. */
  detailed: workspaceProcedure
    .input(detailedReportSchema)
    .query(async ({ ctx, input }): Promise<DetailedReportResult> => {
      return buildDetailed(reportScope(ctx), input, {
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });
    }),

  /** Seven-day timesheet grid, one row per project+task combination. */
  weekly: workspaceProcedure
    .input(weeklyReportSchema)
    .query(async ({ ctx, input }): Promise<WeeklyReportResult> => {
      return buildWeekly(reportScope(ctx), input, input.weekStart);
    }),

  /** Runs the matching report and serializes it for download. */
  exportCsv: workspaceProcedure
    .input(exportCsvSchema)
    .query(async ({ ctx, input }): Promise<CsvExport> => {
      const scope = reportScope(ctx);
      // Decided once, from the scope, for every branch — the header set of a
      // file must not depend on which report happened to be asked for.
      const moneyVisible = reportMoneyVisible(scope.visibility);
      const range = parseRange(input);
      const exportZone = resolveTimeZone(input.timeZone);

      if (input.report === "summary") {
        const result = await buildSummary(
          scope,
          input,
          input.groupBy ?? "project",
        );
        return {
          filename: exportFilename("summary", range, exportZone),
          csv: toCsv(
            summaryCsvRows(result),
            summaryCsvColumns(result.moneyVisible),
          ),
          mimeType: "text/csv",
        };
      }

      if (input.report === "weekly") {
        const weekStart =
          input.weekStart ?? dayKeyInZone(range.fromMs, exportZone);
        const result = await buildWeekly(scope, input, weekStart);
        return {
          filename: exportFilename("weekly", range, exportZone),
          csv: toCsv(weeklyCsvRows(result), weeklyCsvColumns(result)),
          mimeType: "text/csv",
        };
      }

      // Detailed: paginate through the whole range so the export is complete,
      // not just the page the UI happens to be showing.
      const entries: DetailedEntry[] = [];
      let currency = "";
      let cursor: string | undefined;
      let guard = 0;

      do {
        const pageResult: DetailedReportResult = await buildDetailed(
          scope,
          input,
          { limit: EXPORT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          false,
        );
        entries.push(...pageResult.entries);
        currency = pageResult.currency;
        cursor = pageResult.nextCursor;
        guard += 1;
      } while (cursor && guard < MAX_EXPORT_PAGES);

      return {
        filename: exportFilename("detailed", range, exportZone),
        csv: toCsv(
          detailedCsvRows(
            { entries, totalSec: 0, totalAmount: null, currency, moneyVisible },
            exportZone,
          ),
          detailedCsvColumns(moneyVisible),
        ),
        mimeType: "text/csv",
      };
    }),

  /**
   * The same three reports, rendered to PDF on the server.
   *
   * Mirrors `exportCsv` deliberately, branch for branch — same range parsing,
   * same zone resolution, same full-range pagination for the detailed report.
   * The two exports answer the same question in two file formats, so any
   * divergence between them would be a bug, not a feature.
   *
   * Bytes come back base64-encoded because tRPC's transport is JSON; see
   * `PdfExportResult` in @starter/shared for why that beats a second binary
   * HTTP route.
   */
  exportPdf: workspaceProcedure
    .input(exportPdfSchema)
    .query(async ({ ctx, input }): Promise<PdfExportResult> => {
      const scope = reportScope(ctx);
      const moneyVisible = reportMoneyVisible(scope.visibility);
      const range = parseRange(input);
      const exportZone = resolveTimeZone(input.timeZone);
      const generatedAt = new Date().toISOString();
      // The exporting device's language, else the exporter's explicit
      // preference, else English. The CSV sibling above takes none: its
      // headers are the importer's contract.
      const locale = input.locale ?? (await preferredLocale([ctx.user.id]));

      const meta = (title: string, currency: string): PdfReportMeta => ({
        title,
        locale,
        from: dayKeyInZone(range.fromMs, exportZone),
        to: dayKeyInZone(range.toMs - 1, exportZone),
        timeZone: exportZone,
        currency,
        generatedAt,
        moneyVisible,
      });

      const encode = (
        report: string,
        bytes: Buffer,
      ): PdfExportResult => ({
        filename: pdfFilename(report, range, exportZone),
        base64: bytes.toString("base64"),
        mimeType: "application/pdf",
      });

      if (input.report === "summary") {
        const groupBy = input.groupBy ?? "project";
        const result = await buildSummary(scope, input, groupBy);
        const bytes = await renderSummaryPdf(
          result,
          meta(reportPdfTitle(locale, { kind: "summary", groupBy }), result.currency),
          groupBy,
        );
        return encode("summary", bytes);
      }

      if (input.report === "weekly") {
        const weekStart =
          input.weekStart ?? dayKeyInZone(range.fromMs, exportZone);
        const result = await buildWeekly(scope, input, weekStart);
        const settings = await getOrCreateWorkspaceSettings(scope.workspaceId);
        const bytes = await renderWeeklyPdf(
          result,
          meta(reportPdfTitle(locale, { kind: "weekly" }), settings.currency),
        );
        return encode("weekly", bytes);
      }

      // Detailed: paginate through the whole range so the export is complete,
      // not just the page the UI happens to be showing.
      const entries: DetailedEntry[] = [];
      let currency = "";
      let cursor: string | undefined;
      let guard = 0;

      do {
        const pageResult: DetailedReportResult = await buildDetailed(
          scope,
          input,
          { limit: EXPORT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          false,
        );
        entries.push(...pageResult.entries);
        currency = pageResult.currency;
        cursor = pageResult.nextCursor;
        guard += 1;
      } while (cursor && guard < MAX_EXPORT_PAGES);

      const bytes = await renderDetailedPdf(
        { entries, totalSec: 0, totalAmount: null, currency, moneyVisible },
        meta(reportPdfTitle(locale, { kind: "detailed" }), currency),
      );
      return encode("detailed", bytes);
    }),
});
