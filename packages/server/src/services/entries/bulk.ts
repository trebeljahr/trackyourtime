import { bulkEditEntriesSchema, type BulkEditEntriesInput, type BulkEditEntriesResult, type BulkEntryFailure } from "@starter/shared";
import { TimeEntry, toClientTimeEntry, type TimeEntryDocLike } from "../../models/TimeEntry.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import { snapshotRate } from "../entry-stop.js";
import { publishSync } from "../../ws/sync.js";
import { emitWebhookEvent } from "../webhooks/emit.js";
import type { WorkspaceScope } from "../scope.js";
import { resolveRefs } from "./refs.js";
import { resolveTagIds, normalizeTagIds } from "./tags.js";
import { invoicedEntryEditRefusal } from "./invoice-guard.js";

export type BulkEntry = TimeEntryDocLike & { _id: unknown };
type Operation = BulkEditEntriesInput["operation"];
type Plan = { entry: BulkEntry; set: Record<string, unknown> };

/**
 * Item 9 integration seam: preflight must check approval locks, and write must
 * run under the same approval/invoice transaction or lock as single-entry edits.
 * Standalone deployments keep explicit outcomes; never advertise atomicity.
 */
export type BulkEntryStore = {
  member(scope: WorkspaceScope): Promise<boolean>;
  read(scope: WorkspaceScope, ids: string[]): Promise<BulkEntry[]>;
  prepare(scope: WorkspaceScope, entry: BulkEntry, operation: Operation): Promise<Record<string, unknown>>;
  locked(scope: WorkspaceScope, entry: BulkEntry, operation: Operation): Promise<boolean>;
  write(scope: WorkspaceScope, plan: Plan, operation: Operation, originId?: string): Promise<boolean>;
  effects?(scope: WorkspaceScope, plan: Plan, operation: Operation, originId?: string): void | Promise<void>;
};

/** Mongo predicates protect ownership, revision, invoice claim, and tag/task races. */
export function bulkEntryCAS(scope: WorkspaceScope, entry: BulkEntry): Record<string, unknown> {
  return {
    _id: entry._id, workspaceId: scope.workspaceId, authorId: scope.userId,
    updatedAt: entry.updatedAt,
    invoiceId: entry.invoiceId ?? null,
    projectId: entry.projectId ?? null, taskId: entry.taskId ?? null,
    billable: entry.billable, description: entry.description,
    clientId: entry.clientId === undefined ? { $exists: false } : entry.clientId,
    start: entry.start, end: entry.end, durationSec: entry.durationSec,
    hourlyRate: entry.hourlyRate ?? null, currency: entry.currency,
    tagIds: entry.tagIds === undefined ? { $exists: false } : entry.tagIds,
  };
}

export function bulkTagIds(current: readonly string[], operation: Extract<Operation, { kind: "update" }>["tags"]): string[] | undefined {
  if (!operation) return undefined;
  if (operation.mode === "clear") return [];
  if (operation.mode === "set") return [...new Set(operation.ids)];
  if (operation.mode === "add") return [...new Set([...current, ...operation.ids])];
  return current.filter((id) => !operation.ids.includes(id));
}

function failure(error: unknown): BulkEntryFailure {
  if (error instanceof RangeError) return "too-many-tags";
  return "invalid-reference";
}

/** All validation completes before the first write. No unreported Promise.all partial writes. */
export async function executeBulkEdit(scope: WorkspaceScope, raw: BulkEditEntriesInput, store: BulkEntryStore): Promise<BulkEditEntriesResult> {
  const input = bulkEditEntriesSchema.parse(raw);
  const rows = input.entries;
  const operation = input.operation;
  const invalid = new Map<string, BulkEntryFailure>();
  const plans: Plan[] = [];
  const member = (input.workspaceId === undefined || input.workspaceId === scope.workspaceId) && await store.member(scope);
  const found = member ? await store.read(scope, rows.map((row) => row.id)) : [];
  const byId = new Map(found.map((entry) => [String(entry._id), entry]));
  for (const target of rows) {
    const entry = byId.get(target.id);
    if (!entry || entry.workspaceId !== scope.workspaceId || entry.authorId !== scope.userId) {
      invalid.set(target.id, "not-found");
      continue;
    }
    if (entry.updatedAt.toISOString() !== target.expectedUpdatedAt) {
      invalid.set(target.id, "conflict");
      continue;
    }
    if (await store.locked(scope, entry, operation)) {
      invalid.set(target.id, "locked");
      continue;
    }
    const fields = operation.kind === "delete" ? ["start"] :
      ["projectId", "taskId", "billable"].filter((key) => operation[key as "projectId" | "taskId" | "billable"] !== undefined);
    if (invoicedEntryEditRefusal(entry.invoiceId, fields)) {
      invalid.set(target.id, "invoiced");
      continue;
    }
    try {
      const nextTags = operation.kind === "update" ? bulkTagIds(entry.tagIds ?? [], operation.tags) : undefined;
      if (nextTags && nextTags.length > 20) throw new RangeError();
      plans.push({ entry, set: await store.prepare(scope, entry, operation) });
    } catch (error) {
      invalid.set(target.id, failure(error));
    }
  }
  if (invalid.size > 0) return {
    atomic: false, phase: "validation",
    results: rows.map(({ id }) => ({ id, success: false, reason: invalid.get(id) ?? "not-applied" })),
  };

  const results: BulkEditEntriesResult["results"] = [];
  for (const plan of plans) {
    const id = String(plan.entry._id);
    try {
      if (!(await store.member(scope))) {
        results.push({ id, success: false, reason: "not-found" });
      } else if (await store.locked(scope, plan.entry, operation)) {
        results.push({ id, success: false, reason: "locked" });
      } else if (await store.write(scope, plan, operation, input.originId)) {
        results.push({ id, success: true });
        // Notifications are best effort after commit. Even a synchronous
        // effect failure must not describe a committed write as uncertain.
        try { void Promise.resolve(store.effects?.(scope, plan, operation, input.originId)).catch(() => {}); } catch { /* already committed */ }
      } else {
        results.push({ id, success: false, reason: "conflict" });
      }
    } catch {
      // A transport error from Mongo can arrive after the write committed.
      // Keep selection and tell the user to reload before trying it again.
      results.push({ id, success: false, reason: "unconfirmed" });
      for (const remaining of plans.slice(results.length)) {
        results.push({ id: String(remaining.entry._id), success: false, reason: "not-applied" });
      }
      break;
    }
  }
  return { atomic: false, phase: "write", results };
}

export const mongoBulkEntryStore: BulkEntryStore = {
  member: async (scope) => Boolean(await WorkspaceMember.exists({ workspaceId: scope.workspaceId, userId: scope.userId })),
  read: async (scope, ids) => {
    // Malformed and foreign ids have the same outcome, without a cast exception.
    const valid = ids.filter((id) => /^[a-f0-9]{24}$/i.test(id));
    return TimeEntry.find({ _id: { $in: valid }, workspaceId: scope.workspaceId, authorId: scope.userId }).lean();
  },
  // Item 9 replaces this and wraps write with its shared locking policy.
  locked: async () => false,
  prepare: async (scope, entry, operation) => {
    if (operation.kind === "delete") return {};
    const set: Record<string, unknown> = {};
    if (operation.projectId !== undefined || operation.taskId !== undefined) {
      const refs = await resolveRefs(scope.workspaceId, operation.projectId === undefined ? entry.projectId : operation.projectId,
        operation.taskId === undefined ? entry.taskId : operation.taskId);
      if (operation.projectId !== undefined) set.projectId = refs.projectId;
      if (operation.taskId !== undefined) set.taskId = refs.taskId;
    }
    if (operation.billable !== undefined) set.billable = operation.billable;
    if (operation.tags && operation.tags.mode !== "clear") {
      // Remove also validates its named ids, even when a target lacks them.
      await resolveTagIds(scope.workspaceId, operation.tags.ids);
    }
    const tagIds = bulkTagIds(entry.tagIds ?? [], operation.tags);
    if (tagIds !== undefined) {
      normalizeTagIds(tagIds);
      set.tagIds = await resolveTagIds(scope.workspaceId, tagIds);
    }
    if ((operation.projectId !== undefined && operation.projectId !== entry.projectId) ||
      (operation.billable !== undefined && operation.billable !== entry.billable)) {
      const refs = await resolveRefs(scope.workspaceId, operation.projectId === undefined ? entry.projectId : operation.projectId,
        operation.taskId === undefined ? entry.taskId : operation.taskId);
      const settings = await getOrCreateWorkspaceSettings(scope.workspaceId);
      Object.assign(set, snapshotRate(operation.billable ?? entry.billable, refs.project, settings));
      // Existing update semantics freeze a legacy client before moving projects.
      if (entry.clientId === undefined && operation.projectId !== undefined) {
        const previous = await resolveRefs(scope.workspaceId, entry.projectId, null);
        set.clientId = previous.project?.clientId ?? null;
      }
    }
    return set;
  },
  write: async (scope, plan, operation) => {
    const filter = bulkEntryCAS(scope, plan.entry);
    if (operation.kind === "delete") {
      const removed = await TimeEntry.deleteOne(filter);
      if (removed.deletedCount !== 1) return false;
    } else {
      const updated = await TimeEntry.findOneAndUpdate(filter, { $set: {
        ...plan.set, updatedAt: new Date(Math.max(Date.now(), plan.entry.updatedAt.getTime() + 1)),
      } }, { returnDocument: "after", timestamps: false }).lean();
      if (!updated) return false;
      plan.entry = updated;
    }
    return true;
  },
  effects: (scope, plan, operation, originId) => {
    if (operation.kind === "delete") {
      const id = String(plan.entry._id);
      void publishSync(scope.workspaceId, { kind: "entry.deleted", id }, originId, { authorId: scope.userId }).catch(() => {});
      emitWebhookEvent(scope.workspaceId, "entry.deleted", { kind: "entry-deleted", id, authorId: scope.userId });
    } else {
      const entry = toClientTimeEntry(plan.entry);
      void publishSync(scope.workspaceId, { kind: "entry.upserted", entry }, originId).catch(() => {});
      emitWebhookEvent(scope.workspaceId, "entry.updated", { kind: "entry", entry });
    }
  },
};

export async function bulkEditEntries(scope: WorkspaceScope, input: BulkEditEntriesInput): Promise<BulkEditEntriesResult> {
  return executeBulkEdit(scope, input, mongoBulkEntryStore);
}
