import { TRPCError } from "@trpc/server";
import { privateStandardTimerResultInputSchema, standardCurrentTimerSchema } from "@starter/shared";
import { PrivateTimerVersion } from "../../models/PrivateTimer.js";
import { supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { privateTimerVersions } from "./timer-versions.js";
import { startCoordinatedStandardTimer } from "./standard-timer-start.js";
/** Read only the original standard half of an already committed account
 * handoff. Replaying this endpoint can never start or reopen time. Membership
 * and storage mode are rechecked before any standard receipt body is read. */
export async function privateStandardTimerResult(inputScope: { server: string; userId: string }, raw: unknown) {
  const scope = { ...inputScope }, input = structuredClone(privateStandardTimerResultInputSchema.parse(raw));
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Timer receipt reads require MongoDB transactions." });
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(scope.userId);
    const row = await PrivateTimerVersion.findOne({ userId: scope.userId, operationId: input.operationId }).select({ revision: 1 }).lean();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "The original timer handoff is unavailable. Existing time was kept." });
    const page = await privateTimerVersions(scope, row.revision - 1, row.revision), signed = page.versions[0];
    if (page.next !== null || page.versions.length !== 1 || signed?.header.operationId !== input.operationId || signed.header.standardStart?.workspaceId !== input.workspaceId || signed.header.standardStart.entryId !== input.entryId) throw new TRPCError({ code: "NOT_FOUND", message: "The original standard timer handoff does not match this request." });
    const result = standardCurrentTimerSchema.parse(await startCoordinatedStandardTimer({ userId: scope.userId, workspaceId: input.workspaceId }, input.input, input.entryId, input.operationId, true));
    if (result.id !== input.entryId || result.workspaceId !== input.workspaceId || result.authorId !== scope.userId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The original standard timer result could not be verified." });
    return result;
  });
}
