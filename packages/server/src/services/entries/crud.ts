// Manual entries: create, update, delete.
//
// Editing is AUTHOR-only, independent of viewing: `canViewOthersTime` grants
// sight of a colleague's entries, never the right to rewrite them. That is why
// every filter here is `{ workspaceId, authorId }` and NOT `authorScopeFilter`
// — the latter would let a member with the time-visibility flag edit anybody's
// row the moment somebody granted it.
import { TRPCError } from "@trpc/server";
import type {
  CreateEntryInput,
  TimeEntry as TimeEntryWire,
  UpdateEntryInput,
} from "@starter/shared";
import { Project } from "../../models/Project.js";
import { TimeEntry, toClientTimeEntry } from "../../models/TimeEntry.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import { durationBetween, snapshotRate } from "../entry-stop.js";
import { emitWebhookEvent } from "../webhooks/emit.js";
import { publishSync } from "../../ws/sync.js";
import type { WorkspaceScope } from "../scope.js";
import {
  badRequest,
  invoiceConflict,
  isDuplicateKeyError,
  notFound,
  requireObjectId,
} from "./errors.js";
import {
  INVOICE_RELEVANT_FIELDS,
  invoicedEntryEditRefusal,
} from "./invoice-guard.js";
import { resolveRefs } from "./refs.js";
import { resolveTagIds } from "./tags.js";

/** Manual entry with an explicit start and end. */
export async function createEntry(
  scope: WorkspaceScope,
  input: CreateEntryInput,
): Promise<TimeEntryWire> {
  const workspaceId = scope.workspaceId;
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw badRequest("Invalid start/end");
  }
  if (end.getTime() <= start.getTime()) {
    throw badRequest("End must be after start");
  }

  const refs = await resolveRefs(
    workspaceId,
    input.projectId ?? null,
    input.taskId ?? null,
  );
  const tagIds = (await resolveTagIds(workspaceId, input.tagIds)) ?? [];
  const billable = input.billable ?? refs.project?.billableDefault ?? false;
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const { hourlyRate, currency } = snapshotRate(
    billable,
    refs.project,
    settings,
  );

  const created = await TimeEntry.create({
    workspaceId,
    authorId: scope.userId,
    description: input.description,
    projectId: refs.projectId,
    taskId: refs.taskId,
    billable,
    start,
    end,
    durationSec: durationBetween(start, end),
    hourlyRate,
    currency,
    source: input.source ?? "web",
    timeZone: input.timeZone ?? null,
    tagIds,
  });

  const entry = toClientTimeEntry(created);
  void publishSync(
    workspaceId,
    { kind: "entry.upserted", entry },
    input.originId,
  );
  emitWebhookEvent(workspaceId, "entry.created", { kind: "entry", entry });
  return entry;
}

export async function updateEntry(
  scope: WorkspaceScope,
  input: UpdateEntryInput,
): Promise<TimeEntryWire> {
  const workspaceId = scope.workspaceId;
  // Editing is author-only, independent of viewing: `canViewOthersTime`
  // grants sight of a colleague's entries, never the right to rewrite
  // them. Somebody else's entry reads as missing.
  const existing = await TimeEntry.findOne({
    _id: requireObjectId(input.id, "Entry not found"),
    workspaceId,
    authorId: scope.userId,
  }).lean();
  if (!existing) throw notFound();

  // Refuse before doing any work: an entry on an issued invoice is frozen
  // in the ways that invoice was calculated from.
  const refusal = invoicedEntryEditRefusal(
    existing.invoiceId,
    INVOICE_RELEVANT_FIELDS.filter((field) => input[field] !== undefined),
  );
  if (refusal) throw invoiceConflict(refusal);

  const projectChanged = input.projectId !== undefined;
  const taskChanged = input.taskId !== undefined;
  const billableChanged =
    input.billable !== undefined && input.billable !== existing.billable;

  const refs =
    projectChanged || taskChanged
      ? await resolveRefs(
          workspaceId,
          projectChanged ? input.projectId ?? null : existing.projectId,
          taskChanged ? input.taskId ?? null : existing.taskId,
        )
      : {
          projectId: existing.projectId,
          taskId: existing.taskId,
          project: existing.projectId
            ? await Project.findOne({
                _id: existing.projectId,
                workspaceId,
              }).lean()
            : null,
        };

  const start = input.start ? new Date(input.start) : existing.start;
  if (Number.isNaN(start.getTime())) throw badRequest("Invalid start");

  const end =
    input.end === undefined
      ? existing.end
      : input.end === null
        ? null
        : new Date(input.end);
  if (end && Number.isNaN(end.getTime())) throw badRequest("Invalid end");
  if (end && end.getTime() <= start.getTime()) {
    throw badRequest("End must be after start");
  }

  const billable = input.billable ?? existing.billable;
  const durationSec = end ? durationBetween(start, end) : 0;

  // `tagIds` REPLACES the whole set when present. Omitting the key leaves
  // the entry's tags exactly as they were, so a partial edit (rename the
  // description, nudge the end time) can never silently untag an entry.
  const tagIds = await resolveTagIds(workspaceId, input.tagIds);

  // Re-snapshot when the money inputs change, or when this edit is what
  // stops a running entry. Otherwise the historical snapshot stands.
  const stoppedByThisEdit = existing.end === null && end !== null;
  const resnapshot =
    billableChanged ||
    refs.projectId !== existing.projectId ||
    stoppedByThisEdit;

  let hourlyRate = existing.hourlyRate;
  let currency = existing.currency;
  if (resnapshot) {
    const settings = await getOrCreateWorkspaceSettings(workspaceId);
    const snapshot = snapshotRate(billable, refs.project, settings);
    hourlyRate = snapshot.hourlyRate;
    currency = snapshot.currency;
  } else if (!billable) {
    hourlyRate = null;
  }

  let updated;
  try {
    updated = await TimeEntry.findOneAndUpdate(
      { _id: String(existing._id), workspaceId, authorId: scope.userId },
      {
        $set: {
          description: input.description ?? existing.description,
          projectId: refs.projectId,
          taskId: refs.taskId,
          billable,
          start,
          end,
          durationSec,
          hourlyRate,
          currency,
          ...(tagIds !== undefined ? { tagIds } : {}),
        },
      },
      { returnDocument: "after" },
    ).lean();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Another timer is already running",
      });
    }
    throw error;
  }
  if (!updated) throw notFound();

  const entry = toClientTimeEntry(updated);
  void publishSync(
    workspaceId,
    { kind: "entry.upserted", entry },
    input.originId,
  );
  emitWebhookEvent(workspaceId, "entry.updated", { kind: "entry", entry });
  return entry;
}

export async function deleteEntry(
  scope: WorkspaceScope,
  input: { id: string; originId?: string },
): Promise<{ success: true; id: string }> {
  const entryId = requireObjectId(input.id, "Entry not found");

  // Deleting billed time is the worst version of the divergence the
  // update guard prevents: the invoice would go on claiming hours whose
  // entry no longer exists, so it cannot be reconciled at all.
  // Author-only, for the same reason as `update`.
  const existing = await TimeEntry.findOne({
    _id: entryId,
    workspaceId: scope.workspaceId,
    authorId: scope.userId,
  })
    .select("invoiceId")
    .lean();
  if (!existing) throw notFound();
  if (existing.invoiceId) {
    throw invoiceConflict(
      "This time has already been invoiced and cannot be deleted. " +
        "Delete the invoice while it is still a draft to release its " +
        "time, then delete the entry.",
    );
  }

  const result = await TimeEntry.deleteOne({
    _id: entryId,
    workspaceId: scope.workspaceId,
    authorId: scope.userId,
  });
  if (result.deletedCount === 0) throw notFound();

  // The audience is what lets the fan-out send an id-only event to the
  // author's other devices without also telling a colleague who may not see
  // the author's time that an entry just disappeared.
  void publishSync(
    scope.workspaceId,
    { kind: "entry.deleted", id: input.id },
    input.originId,
    { authorId: scope.userId },
  );
  emitWebhookEvent(scope.workspaceId, "entry.deleted", {
    kind: "entry-deleted",
    id: input.id,
    // Explicit, because the row is gone by the time the delivery is sent.
    authorId: scope.userId,
  });
  return { success: true, id: input.id };
}
