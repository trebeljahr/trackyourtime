import { TRPCError } from "@trpc/server";
import { standardCurrentTimerSchema } from "@starter/shared";
import { TimeEntry } from "../../models/TimeEntry.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { currentEntry, personReach } from "../entries/timer.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { assertStandardWorkspace } from "./access.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { assertNoPrivateRunningTimer } from "./timer-state.js";
/** Account-wide standard read, independent of the selected workspace. Check
 * the actual storage mode and membership before any original body/runaway
 * processing. Private current records are only opened by the client. */
export async function standardAccountCurrentTimer(userId: string) {
  if (typeof userId !== "string" || !userId || userId.length > 100) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account timer reads require MongoDB transactions." });
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(userId); await assertNoPrivateRunningTimer(userId, true);
    const pointer = await TimeEntry.findOne({ authorId: userId, end: null }).select({ workspaceId: 1 }).lean();
    if (!pointer) return null;
    await fenceWorkspace(pointer.workspaceId); await assertStandardWorkspace(pointer.workspaceId);
    if (!await WorkspaceMember.exists({ userId, workspaceId: pointer.workspaceId })) throw new TRPCError({ code: "NOT_FOUND", message: "Current timer workspace access changed. Existing time was kept." });
    return standardCurrentTimerSchema.nullable().parse(await currentEntry({ userId, workspaceId: pointer.workspaceId, visibility: { userId, canViewOthersTime: false, canViewOthersMoney: false } }, personReach));
  });
}
