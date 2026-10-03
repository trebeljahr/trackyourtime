import { TRPCError } from "@trpc/server";
import {
  approvalWeekBounds, intervalIntersects, weekStartKey,
  type TimesheetApprovalWire, type Visibility,
} from "@starter/shared";
import { TimesheetApproval, TimesheetPolicy, type ApprovalPolicy, type ApprovalRecord } from "../../models/TimesheetApproval.js";
import { TimeEntry, toClientTimeEntry, type TimeEntryDocLike } from "../../models/TimeEntry.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import { approvalConflict, fenceWorkspace, supportsBusinessTransactions, transactional } from "../business-transaction.js";
import { publishSync } from "../../ws/sync.js";

export type ApprovalActor = { workspaceId: string; userId: string; role: string; visibility: Visibility };
export type PolicyView = ApprovalPolicy & { transactionsSupported: boolean; canReview: boolean; canConfigure: boolean };
export function canReviewTimesheets(actor: ApprovalActor): boolean {
  return (actor.role === "owner" || actor.role === "admin") && actor.visibility.canViewOthersTime;
}
const notFound = (): TRPCError => new TRPCError({ code: "NOT_FOUND" });
export async function approvalPolicy(actor: ApprovalActor): Promise<PolicyView> {
  const stored = await TimesheetPolicy.findOne({ workspaceId: actor.workspaceId }).lean();
  return {
    workspaceId: actor.workspaceId, enabled: stored?.enabled ?? false,
    requireApprovedForInvoices: stored?.requireApprovedForInvoices ?? false,
    timeZone: stored?.timeZone ?? "UTC", transactionsSupported: await supportsBusinessTransactions(),
    canReview: canReviewTimesheets(actor), canConfigure: actor.role === "owner" || actor.role === "admin",
  };
}

export const configureApprovals = transactional(async (
  actor: ApprovalActor, input: Omit<ApprovalPolicy, "workspaceId">,
): Promise<PolicyView> => {
  if (actor.role !== "owner" && actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "TIMESHEET_REVIEW_PERMISSION" });
  if (!(await supportsBusinessTransactions())) throw approvalConflict("TIMESHEET_TRANSACTIONS_UNAVAILABLE");
  await fenceWorkspace(actor.workspaceId);
  const policy = await TimesheetPolicy.findOne({ workspaceId: actor.workspaceId }).lean();
  if (input.requireApprovedForInvoices && !input.enabled) throw approvalConflict("TIMESHEET_DISABLED");
  // Money visibility controls invoice policy, independently of time review.
  if (input.requireApprovedForInvoices !== (policy?.requireApprovedForInvoices ?? false) && !actor.visibility.canViewOthersMoney) {
    throw new TRPCError({ code: "FORBIDDEN", message: "invoice-permission-required" });
  }
  if (!input.enabled && await TimesheetApproval.exists({ workspaceId: actor.workspaceId, status: { $nin: ["draft", "rejected"] } })) throw approvalConflict();
  await TimesheetPolicy.updateOne({ workspaceId: actor.workspaceId }, { $set: input }, { upsert: true });
  void publishSync(actor.workspaceId, { kind: "settings.changed" });
  return approvalPolicy(actor);
});

function overlapFilter(start: Date, end: Date): Record<string, unknown> {
  return { start: { $lt: end }, $or: [{ end: null }, { end: { $gt: start } }, { start: { $gte: start }, end: { $gte: start } }] };
}
async function wire(record: ApprovalRecord & { _id: unknown }): Promise<TimesheetApprovalWire> {
  const member = await WorkspaceMember.findOne({ workspaceId: record.workspaceId, userId: record.authorId }).lean();
  const [totals] = await TimeEntry.aggregate<{ totalSec: number }>([
    { $match: { workspaceId: record.workspaceId, authorId: record.authorId, ...overlapFilter(record.start, record.end) } },
    { $group: { _id: null, totalSec: { $sum: "$durationSec" } } },
  ]);
  return {
    id: String(record._id), workspaceId: record.workspaceId, authorId: record.authorId,
    authorName: member?.name ?? "", weekStart: record.weekStart, weekStartsOn: record.weekStartsOn,
    timeZone: record.timeZone, start: record.start.toISOString(), end: record.end.toISOString(),
    status: record.status, revision: record.revision, totalSec: totals?.totalSec ?? 0,
    history: record.history.map((item) => ({ ...item, at: item.at.toISOString() })),
  };
}

async function requestedBounds(actor: ApprovalActor, weekStart: string): Promise<{ policy: PolicyView; weekStartsOn: 0 | 1; start: Date; end: Date }> {
  const policy = await approvalPolicy(actor);
  const settings = await getOrCreateWorkspaceSettings(actor.workspaceId);
  const date = new Date(weekStart + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== weekStart || weekStartKey(weekStart, settings.weekStartsOn) !== weekStart) throw approvalConflict("TIMESHEET_INVALID_WEEK");
  return { policy, weekStartsOn: settings.weekStartsOn, ...approvalWeekBounds(weekStart, policy.timeZone) };
}

/** Existing overlapping records are shown even after zone/week-start changes.
 * A new view never hides a durable lock under a different calendar label. */
export async function ownApprovalWeek(actor: ApprovalActor, weekStart: string): Promise<{ policy: PolicyView; records: TimesheetApprovalWire[]; start: string; end: string }> {
  const { policy, start, end } = await requestedBounds(actor, weekStart);
  const records = await TimesheetApproval.find({ workspaceId: actor.workspaceId, authorId: actor.userId, start: { $lt: end }, end: { $gt: start } }).sort({ start: 1 }).lean();
  const rows = [];
  for (const record of records) rows.push(await wire(record));
  return { policy, records: rows, start: start.toISOString(), end: end.toISOString() };
}

export const submitTimesheet = transactional(async (
  actor: ApprovalActor, input: { weekStart: string; confirmedOnline: true; pendingLocalEdits: false },
): Promise<TimesheetApprovalWire> => {
  if (!input.confirmedOnline || input.pendingLocalEdits !== false) throw approvalConflict("TIMESHEET_PENDING_EDITS");
  if (!(await supportsBusinessTransactions())) throw approvalConflict("TIMESHEET_TRANSACTIONS_UNAVAILABLE");
  await fenceWorkspace(actor.workspaceId);
  const { policy, start, end, weekStartsOn } = await requestedBounds(actor, input.weekStart);
  if (!policy.enabled) throw approvalConflict("TIMESHEET_DISABLED");
  if (start > new Date()) throw approvalConflict("TIMESHEET_FUTURE_WEEK");
  const overlapping = await TimesheetApproval.find({ workspaceId: actor.workspaceId, authorId: actor.userId, start: { $lt: end }, end: { $gt: start } }).lean();
  if (overlapping.some((row) => !["draft", "rejected"].includes(row.status))) throw approvalConflict();
  const entryScope = { workspaceId: actor.workspaceId, authorId: actor.userId };
  if (await TimeEntry.exists({ ...entryScope, start: { $lt: end }, end: null })) throw approvalConflict("TIMESHEET_RUNNING_ENTRY");
  if (await TimeEntry.exists({ ...entryScope, $and: [overlapFilter(start, end), { $or: [{ start: { $lt: start } }, { end: { $gt: end } }] }] })) throw approvalConflict("TIMESHEET_CROSS_WEEK_ENTRY");
  const event = { action: "submit", actorId: actor.userId, at: new Date(), reason: "" };
  const record = await TimesheetApproval.findOneAndUpdate(
    { workspaceId: actor.workspaceId, authorId: actor.userId, start, end },
    { $set: { weekStart: input.weekStart, weekStartsOn, timeZone: policy.timeZone, status: "submitted" }, $inc: { revision: 1 }, $push: { history: event } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  if (!record) throw notFound();
  void publishSync(actor.workspaceId, { kind: "settings.changed" });
  return wire(record);
});

export const actOnTimesheet = transactional(async (
  actor: ApprovalActor, input: { id: string; revision: number; action: "withdraw" | "approve" | "reject" | "reopen"; reason?: string },
): Promise<TimesheetApprovalWire> => {
  if (!(await supportsBusinessTransactions())) throw approvalConflict("TIMESHEET_TRANSACTIONS_UNAVAILABLE");
  await fenceWorkspace(actor.workspaceId);
  const record = await TimesheetApproval.findOne({ _id: input.id, workspaceId: actor.workspaceId }).lean();
  if (!record || (record.authorId !== actor.userId && !canReviewTimesheets(actor))) throw notFound();
  if (input.action === "withdraw") {
    if (record.authorId !== actor.userId) throw notFound();
  } else if (!canReviewTimesheets(actor)) throw new TRPCError({ code: "FORBIDDEN", message: "TIMESHEET_REVIEW_PERMISSION" });
  const expected = input.action === "reopen" ? "approved" : "submitted";
  if (record.revision !== input.revision || record.status !== expected) throw approvalConflict("TIMESHEET_STALE");
  const reason = input.reason?.trim() ?? "";
  if (["reject", "reopen"].includes(input.action) && !reason) throw approvalConflict("TIMESHEET_REASON_REQUIRED");
  if (input.action === "reopen" && await TimeEntry.exists({ workspaceId: actor.workspaceId, authorId: record.authorId, invoiceId: { $ne: null }, ...overlapFilter(record.start, record.end) })) throw approvalConflict("TIMESHEET_INVOICED");
  const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "draft";
  const changed = await TimesheetApproval.findOneAndUpdate(
    { _id: record._id, workspaceId: actor.workspaceId, revision: input.revision, status: expected },
    { $set: { status }, $inc: { revision: 1 }, $push: { history: { action: input.action, actorId: actor.userId, at: new Date(), reason } } },
    { returnDocument: "after" },
  ).lean();
  if (!changed) throw approvalConflict("TIMESHEET_STALE");
  void publishSync(actor.workspaceId, { kind: "settings.changed" });
  return wire(changed);
});

export async function reviewQueue(actor: ApprovalActor, page = 0): Promise<{ records: TimesheetApprovalWire[]; hasMore: boolean }> {
  if (!canReviewTimesheets(actor)) throw new TRPCError({ code: "FORBIDDEN", message: "TIMESHEET_REVIEW_PERMISSION" });
  // Submitted sorts ahead of approved, so history never crowds out pending work.
  const records = await TimesheetApproval.find({ workspaceId: actor.workspaceId, status: { $in: ["submitted", "approved"] } }).sort({ status: -1, start: -1, _id: -1 }).skip(page * 25).limit(26).lean();
  const rows = [];
  for (const record of records.slice(0, 25)) rows.push(await wire(record));
  return { records: rows, hasMore: records.length > 25 };
}

/** Review is a time-only document. No invoice ids, rates or money-derived
 * values cross this API, regardless of the reviewer's monetary visibility. */
export type ApprovalEntry = Pick<ReturnType<typeof toClientTimeEntry>, "id" | "authorId" | "description" | "start" | "end" | "durationSec" | "projectId" | "taskId" | "tagIds">;
export async function approvalEntries(actor: ApprovalActor, id: string, page = 0): Promise<{ entries: ApprovalEntry[]; hasMore: boolean }> {
  const record = await TimesheetApproval.findOne({ _id: id, workspaceId: actor.workspaceId }).lean();
  if (!record || (record.authorId !== actor.userId && !canReviewTimesheets(actor))) throw notFound();
  const rows = await TimeEntry.find({ workspaceId: actor.workspaceId, authorId: record.authorId, ...overlapFilter(record.start, record.end) }).sort({ start: 1, _id: 1 }).skip(page * 100).limit(101).lean();
  return { entries: rows.slice(0, 100).map((row) => ({
    id: String(row._id), authorId: row.authorId, description: row.description,
    start: row.start.toISOString(), end: row.end?.toISOString() ?? null,
    durationSec: row.durationSec, projectId: row.projectId, taskId: row.taskId, tagIds: row.tagIds ?? [],
  })), hasMore: rows.length > 100 };
}

/** Invoice preview seam. Claim-time guard rechecks this inside the transaction. */
export async function invoiceApprovalEligibility(workspaceId: string, entries: readonly Pick<TimeEntryDocLike, "_id" | "authorId" | "start" | "end">[]): Promise<Set<string>> {
  const policy = await TimesheetPolicy.findOne({ workspaceId }).lean();
  const periods = await TimesheetApproval.find({ workspaceId, status: { $nin: ["draft", "rejected"] } }).lean();
  return new Set(entries.filter((entry) => {
    const matches = periods.filter((period) => period.authorId === entry.authorId && intervalIntersects(entry.start, entry.end, period.start, period.end));
    if (matches.some((period) => period.status !== "approved")) return false;
    return !policy?.requireApprovedForInvoices || matches.some((period) => period.status === "approved" && entry.end !== null && entry.start >= period.start && entry.end <= period.end);
  }).map((entry) => String(entry._id)));
}
