import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { privateStandardTimerStartInputSchema, type PrivateStandardTimerStartInput } from "@starter/shared";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { withEntryOperation } from "../entries/operation.js";
import { startNewEntry, personReach } from "../entries/timer.js";
import { publishSync } from "../../ws/sync.js";
import { emitWebhookEvent } from "../webhooks/emit.js";
import { assertStandardWorkspace } from "./access.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
/** Internal half of an atomic private-to-standard handoff. Its parent first
 * closes encrypted time and publishes the inactive account checkpoint in the
 * same transaction. Standard plaintext and its retry hash stay exclusively in
 * this standard workspace's row/receipt, never retained account metadata. */
export async function startCoordinatedStandardTimer(inputScope: { userId: string; workspaceId: string }, raw: PrivateStandardTimerStartInput, inputEntryId: string, inputOperationId: string, replayOnly = false) {
  const scope = { userId: z.string().min(1).max(100).parse(inputScope.userId), workspaceId: z.string().min(1).max(100).parse(inputScope.workspaceId) };
  const input = structuredClone(privateStandardTimerStartInputSchema.parse(raw)), entryId = z.string().regex(/^[a-f0-9]{24}$/).parse(inputEntryId), operationId = z.uuid().parse(inputOperationId);
  const receiptInput = { operationId, entryId, ...input };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Coordinated timer starts require MongoDB transactions." });
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(scope.userId); await fenceWorkspace(scope.workspaceId); await assertStandardWorkspace(scope.workspaceId);
    if (!await WorkspaceMember.exists(scope)) throw new TRPCError({ code: "NOT_FOUND" });
    return withEntryOperation(scope, "private:timer:standardStart", receiptInput, async () => {
      if (replayOnly) throw new TRPCError({ code: "CONFLICT", message: "The original standard timer receipt is missing. Existing time was kept." });
      // A parent account handoff replaces only its signed private predecessor.
      // Never let the ordinary start helper silently stop unrelated standard time.
      if (await TimeEntry.exists({ authorId: scope.userId, end: null })) throw new TRPCError({ code: "CONFLICT", message: "The account timer changed. Existing time was kept." });
      const { entry } = await startNewEntry({ entryId, workspaceId: scope.workspaceId, authorId: scope.userId, reach: personReach, description: input.description ?? "", clientId: input.clientId, projectId: input.projectId ?? null, taskId: input.taskId ?? null, billable: input.billable, start: new Date(input.start), source: input.source ?? "web", timeZone: input.timeZone ?? null, tagIds: input.tagIds, originId: input.originId });
      void publishSync(scope.workspaceId, { kind: "timer.started", entry }, input.originId);
      emitWebhookEvent(scope.workspaceId, "entry.started", { kind: "entry", entry });
      return entry;
    });
  });
}
