import { TRPCError } from "@trpc/server";
import { privateStandardContinueTimerInputSchema } from "@starter/shared";
import { WorkspaceMember, visibilityOf } from "../../models/WorkspaceMember.js";
import { prepareContinuedEntry } from "../entries/timer.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { assertStandardWorkspace } from "./access.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
/** Prepare only a standard source's reusable fields. The caller persists this
 * recipe before the separate atomic handoff can close or start any time. */
export async function standardContinueTimerInput(userId: string, raw: unknown) {
  const input = structuredClone(privateStandardContinueTimerInputSchema.parse(raw));
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Timer continuation preparation requires MongoDB transactions." });
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(userId); await fenceWorkspace(input.workspaceId); await assertStandardWorkspace(input.workspaceId);
    const member = await WorkspaceMember.findOne({ userId, workspaceId: input.workspaceId }).lean();
    if (!member) throw new TRPCError({ code: "NOT_FOUND" });
    return prepareContinuedEntry({ userId, workspaceId: input.workspaceId, visibility: visibilityOf(member) }, input, input.at);
  });
}
