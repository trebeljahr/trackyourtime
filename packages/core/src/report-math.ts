import { addDaysToKey, currencyAmountsAccumulator, dayKeyInZone, entryAmount, monthKeyOf, projectDetailedEntry, reportMoneyVisible, singleCurrencyMoney, splitIntervalByZonedDay, weekStartKey, type CurrencyAmountsAccumulator, type DayKey, type DetailedEntry, type DetailedReportResult, type ReportGroupBy, type SummaryGroup, type SummaryReportResult, type Visibility, type WeekStart, type ParallelShare } from "@starter/shared";
/** Pure report arithmetic. It retains no dataset and performs no I/O; every
 * caller must first supply its own authenticated/scoped input rows. */
export type ReportRange = { fromMs: number; toMs: number };
export type ReportCalendar = { timeZone: string; weekStartsOn: WeekStart };
export type ReportMeasureSource = { start: Date; end: Date | null; durationSec: number; billable: boolean; hourlyRate: number | null; currency: string };
type CatalogDoc = { _id?: unknown; workspaceId: string; name: string };
export type ReportGroupingSource = { authorId: string; project?: (CatalogDoc & { color: string }) | null; client?: (CatalogDoc & { color: string | null }) | null; task?: CatalogDoc | null };
const inWorkspace = <T extends { workspaceId: string }>(doc: T | null | undefined, workspaceId: string): T | null => doc && doc.workspaceId === workspaceId ? doc : null;
const DAYS_PER_WEEK = 7;
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

export type ReportMeasuredEntry<T extends ReportMeasureSource> = {
  doc: T;
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

export type ClippedReportEntry = {
  /** Seconds inside the range — always a positive integer. */
  seconds: number;
  clipStart: number;
  clipEnd: number;
};

/**
 * The part of an entry inside the range, or null when nothing of it is.
 *
 * The one copy of the clip rule. Every figure a report states — a group, a
 * range total, an export's headline — is measured through it, so none of
 * them can disagree about what an entry contributes.
 */
export const clipReportToRange = (
  entry: { start: Date; end: Date | null; durationSec: number },
  range: ReportRange,
  nowMs: number,
): ClippedReportEntry | null => {
  const startMs = entry.start.getTime();
  const rawEndMs = entry.end === null ? nowMs : entry.end.getTime();

  const clipStart = Math.max(startMs, range.fromMs);
  const clipEnd = Math.min(rawEndMs, range.toMs);
  if (!(clipEnd > clipStart)) return null;

  const untouched =
    entry.end !== null &&
    entry.durationSec > 0 &&
    startMs >= range.fromMs &&
    rawEndMs <= range.toMs;

  const seconds = untouched
    ? Math.round(entry.durationSec)
    : Math.max(0, Math.round((clipEnd - clipStart) / 1000));
  return seconds > 0 ? { seconds, clipStart, clipEnd } : null;
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
export const measureReportEntry = <T extends ReportMeasureSource>(
  doc: T,
  range: ReportRange,
  nowMs: number,
  calendar: ReportCalendar,
  /**
   * The entry's even share of time it spent overlapping the author's other
   * entries (`parallelShares` over the same range and zone), when it
   * overlapped any. It replaces the clipped length, day by day.
   */
  share?: ParallelShare,
): ReportMeasuredEntry<T> | null => {
  const clipped = clipReportToRange(doc, range, nowMs);
  if (!clipped) return null;
  if (share) {
    const slices = share.slices.map((slice) => ({ date: slice.date as DayKey, seconds: slice.seconds }));
    return {
      doc,
      seconds: share.seconds,
      billableSec: doc.billable ? share.seconds : 0,
      amount: entryAmount(share.seconds, doc.billable ? doc.hourlyRate : null),
      slices,
      dayKey: dayKeyInZone(clipped.clipStart, calendar.timeZone),
    };
  }
  const { seconds, clipStart, clipEnd } = clipped;

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
    // The first slice starts at `clipStart`, so it already names that day.
    dayKey: slices[0]?.date ?? dayKeyInZone(clipStart, calendar.timeZone),
  };
};

export type GroupIdentity = {
  key: string;
  label: string;
  color: string | null;
};

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
export type TagLabel = { name: string; color: string; hidden?: boolean };

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
    if (!tag || tag.hidden) continue;
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

export const reportGroupIdentity = (
  measured: { doc: ReportGroupingSource; dayKey: DayKey },
  // "tag" is excluded on purpose: it is the one grouping that cannot produce
  // ONE identity per entry, so it never reaches this function — see
  // `tagGroupIdentities`. Excluding it here keeps the switch below exhaustive
  // without a lying placeholder arm.
  groupBy: Exclude<ReportGroupBy, "tag">,
  workspaceId: string,
  calendar: ReportCalendar,
): GroupIdentity => {
  const { doc } = measured;
  const project = inWorkspace(doc.project, workspaceId);
  const client = inWorkspace(doc.client, workspaceId);
  const task = inWorkspace(doc.task, workspaceId);

  switch (groupBy) {
    case "member":
      // Named after the fold, once every author is known — see
      // `buildSummary`. Until then the label is a placeholder nothing reads.
      return { key: doc.authorId, label: FORMER_MEMBER_LABEL, color: null };

    case "project":
      return project
        ? {
            key: String(project._id),
            label: project.name,
            color: project.color,
          }
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
  amounts: CurrencyAmountsAccumulator;
};

/** What one measured entry contributes to whichever groups it lands in. */
export type GroupContribution = {
  currency: string;
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
      amounts: currencyAmountsAccumulator(),
    };
    group.seconds += contribution.seconds;
    group.billableSec += contribution.billableSec;
    group.amounts.add({ amount: contribution.amount, currency: contribution.currency });
    groups.set(identity.key, group);
  }
};

/** Biggest first, ties broken by key so the order is stable across calls. */
export const sortGroups = (
  groups: Iterable<GroupAccumulator>,
): SummaryGroup[] =>
  [...groups]
    .map(({ key, label, color, seconds, billableSec, amounts }) => {
      const buckets = amounts.result();
      const scalar = singleCurrencyMoney(buckets, "");
      return { key, label, color, seconds, billableSec, amount: scalar.amount,
        currency: scalar.currency, amounts: buckets };
    })
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));

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
  totalAmounts: null,
  groups: result.groups.map((group) => ({ ...group, amount: null, amounts: null, currency: "" })),
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
    entries: entries.map((entry) => ({
      ...entry,
      hourlyRate: null,
      amount: null,
    })),
    totalAmount: null,
    totalAmounts: null,
    moneyVisible: false,
  };
};

