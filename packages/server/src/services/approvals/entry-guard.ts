import { type Model, type Query, type Schema } from "mongoose";
import { intervalIntersects } from "@starter/shared";
import { TimesheetApproval, TimesheetPolicy } from "../../models/TimesheetApproval.js";
import type { ITimeEntry } from "../../models/TimeEntry.js";
import { approvalConflict, fenceWorkspace, transactionSession, withBusinessTransaction } from "../business-transaction.js";

type Span = { workspaceId: string; authorId: string; start: Date; end: Date | null };
const MUTATIONS = new Set(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"]);

async function prepare(workspaceId: string): Promise<void> {
  if (transactionSession()) await fenceWorkspace(workspaceId);
  else if (await TimesheetPolicy.exists({ workspaceId, enabled: true }) || await TimesheetApproval.exists({ workspaceId, status: { $nin: ["draft", "rejected"] } })) {
    throw approvalConflict("TIMESHEET_TRANSACTIONS_UNAVAILABLE");
  }
}

/** Advisory preflight for bulk outcome labels. The guarded write rechecks
 * under its transaction fence, so a submission racing this read still wins. */
export async function entryIsApprovalLocked(span: Span): Promise<boolean> {
  const upper = span.end === null ? {} : { start: span.end > span.start ? { $lt: span.end } : { $lte: span.start } };
  return Boolean(await TimesheetApproval.exists({ workspaceId: span.workspaceId, authorId: span.authorId,
    status: { $nin: ["draft", "rejected"] }, end: { $gt: span.start }, ...upper }));
}

export async function assertEntryWritable(span: Span, invoiceChange?: string | null): Promise<void> {
  await assertEntriesWritable([span], invoiceChange);
}

/** One bounded lock read per workspace for a batch, not one round trip per
 * imported/repriced row. Fences are held until the enclosing transaction ends. */
async function assertEntriesWritable(spans: readonly Span[], invoiceChange?: string | null): Promise<void> {
  for (const span of spans) {
    if (!(span.start instanceof Date) || !Number.isFinite(span.start.getTime()) ||
      (span.end !== null && (!(span.end instanceof Date) || !Number.isFinite(span.end.getTime()) || span.end < span.start))) {
      throw approvalConflict("TIMESHEET_INVALID_INTERVAL");
    }
  }
  const workspaces = [...new Set(spans.map((span) => span.workspaceId))].sort();
  for (const workspaceId of workspaces) {
    await prepare(workspaceId);
    const group = spans.filter((span) => span.workspaceId === workspaceId);
    const minimumStart = new Date(group.reduce((value, span) => Math.min(value, span.start.getTime()), Infinity));
    const maximumEnd = new Date(group.reduce((value, span) => Math.max(value, span.end?.getTime() ?? 8640000000000000), -Infinity));
    const periods = await TimesheetApproval.find({
      workspaceId, authorId: { $in: [...new Set(group.map((span) => span.authorId))] },
      status: { $nin: ["draft", "rejected"] }, start: { $lte: maximumEnd }, end: { $gt: minimumStart },
    }).lean();
    const requireApproved = typeof invoiceChange === "string" &&
      (await TimesheetPolicy.findOne({ workspaceId }).lean())?.requireApprovedForInvoices;
    for (const span of group) {
      const intersecting = periods.filter((period) => period.authorId === span.authorId && intervalIntersects(span.start, span.end, period.start, period.end));
      if (invoiceChange !== undefined) {
        // Only invoice attribution changes; approved tracked work stays frozen.
        if (intersecting.some((period) => period.status !== "approved")) throw approvalConflict();
        if (requireApproved && !intersecting.some((period) => period.status === "approved" && span.end !== null && span.start >= period.start && span.end <= period.end)) throw approvalConflict("TIMESHEET_APPROVAL_REQUIRED");
      } else if (intersecting.length) throw approvalConflict();
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only supported, inspectable update operators. Never guess at a pipeline's
 * proposed interval; a future writer must explicitly add its operation here. */
function proposedSpan(before: Span, update: Record<string, unknown>): Span {
  const set = record(update.$set);
  for (const [operator, values] of Object.entries(update)) {
    if (!["$set", "$unset", "$pull", "$addToSet", "$push", "$setOnInsert", "$inc"].includes(operator)) throw approvalConflict();
    for (const key of Object.keys(record(values))) {
      if (["workspaceId", "authorId"].some((name) => key === name || key.startsWith(name + "."))) throw approvalConflict();
      if (["start", "end"].some((name) => key === name || key.startsWith(name + ".")) && (operator !== "$set" || key.includes("."))) throw approvalConflict();
    }
  }
  return { ...before,
    start: set.start === undefined ? before.start : new Date(set.start instanceof Date ? set.start.getTime() : String(set.start)),
    end: set.end === undefined ? before.end : set.end === null ? null : new Date(set.end instanceof Date ? set.end.getTime() : String(set.end)),
  };
}

export function entryApprovalGuards(schema: Schema<ITimeEntry>): void {
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"], async function () {
    if (this.getOptions().upsert || ["replaceOne", "findOneAndReplace"].includes((this as unknown as { op: string }).op)) throw approvalConflict();
    const filter = this.getFilter();
    if (typeof filter.workspaceId === "string") await prepare(filter.workspaceId);
    const rows = await this.model.find(filter).lean<Span[]>();
    const raw = this.getUpdate();
    if (Array.isArray(raw)) throw approvalConflict();
    const update = record(raw);
    const set = record(update.$set);
    const fields = Object.entries(update).flatMap(([op, values]) => op === "$setOnInsert" ? [] : Object.keys(record(values))).filter((key) => key !== "updatedAt");
    const invoiceOnly = fields.length === 1 && fields[0] === "invoiceId" && (typeof set.invoiceId === "string" || set.invoiceId === null);
    const spans = rows.flatMap((row) => raw ? [row, proposedSpan(row, update)] : [row]);
    await assertEntriesWritable(spans, invoiceOnly ? set.invoiceId as string | null : undefined);
  });
  schema.pre("save", async function () {
    const model = this.constructor as Model<ITimeEntry>;
    if (!this.isNew) {
      const old = await model.findById(this._id).lean();
      if (old) await assertEntryWritable(old);
    }
    await assertEntryWritable(this);
  });
  schema.pre("insertMany", async function (docs: unknown) {
    const spans: Span[] = [];
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
      const row = record(doc);
      if (typeof row.workspaceId !== "string" || typeof row.authorId !== "string") throw approvalConflict();
      spans.push({ workspaceId: row.workspaceId, authorId: row.authorId, start: new Date(row.start instanceof Date ? row.start.getTime() : String(row.start)), end: row.end == null ? null : new Date(row.end instanceof Date ? row.end.getTime() : String(row.end)) });
    }
    await assertEntriesWritable(spans);
  });
  // No application caller uses bulkWrite. Fail closed until an implementation
  // handles every operation, including replacements and inserts, atomically.
  schema.pre("bulkWrite", async function () { throw approvalConflict(); });
}

/** Model-local transaction boundaries cover REST, jobs, imports and future
 * writers too. Service transactions encompass multi-step domain operations.
 * Clone each query attempt: Mongoose queries cannot execute twice on retry. */
export function installEntryTransactionBoundary(model: Model<ITimeEntry>): void {
  const queryPrototype = (model as unknown as { Query: { prototype: Query<unknown, ITimeEntry> } }).Query.prototype;
  const exec = queryPrototype.exec;
  queryPrototype.exec = function (...args: Parameters<typeof exec>): ReturnType<typeof exec> {
    if (!MUTATIONS.has((this as unknown as { op: string }).op) || transactionSession()) return Reflect.apply(exec, this, args);
    return withBusinessTransaction(() => Reflect.apply(exec, this.clone(), args));
  };
  const save = model.prototype.save;
  model.prototype.save = function (this: ITimeEntry, ...args: unknown[]): Promise<unknown> {
    return withBusinessTransaction(() => Reflect.apply(save, this, args));
  };
  const insertMany = model.insertMany;
  model.insertMany = function (...args: unknown[]): Promise<unknown> {
    return withBusinessTransaction(() => Reflect.apply(insertMany, model, args));
  } as typeof insertMany;
  const create = model.create;
  model.create = function (...args: unknown[]): Promise<unknown> {
    return withBusinessTransaction(() => {
      if (Array.isArray(args[0])) return Reflect.apply(create, model, [args[0], { ...record(args[1]), ordered: true }]);
      return Reflect.apply(create, model, args);
    });
  } as typeof create;
}
