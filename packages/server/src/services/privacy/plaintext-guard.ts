import { AsyncLocalStorage } from "node:async_hooks";
import { TRPCError } from "@trpc/server";
import { PRIVATE_WORKSPACE_REQUIRED } from "@starter/shared";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { fenceWorkspace, transactionSession } from "../business-transaction.js";
import { discardPrivatePreparation } from "./preparation.js";
const erasure = new AsyncLocalStorage<ReadonlySet<string>>();
/** Internal account-erasure exception, limited to the workspaces selected by
 * its already-authorized deletion plan. Ordinary member/role changes never
 * receive this exception. It still acquires the same transaction fence. */
export function withPrivateWorkspaceErasure<T>(workspaceIds: readonly string[], work: () => Promise<T>): Promise<T> {
  return erasure.run(new Set([...(erasure.getStore() ?? []), ...workspaceIds]), work);
}
/** Called inside every guarded plaintext model write, after selecting affected
 * rows in the transaction snapshot. Migration takes this same fence before
 * freezing its source; a stale writer must retry and then refuse the mode. */
export async function guardPlaintextWorkspaceWrites(workspaceIds: readonly string[]): Promise<void> {
  if (!transactionSession()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace storage protection requires MongoDB transactions." });
  for (const workspaceId of [...new Set(workspaceIds.filter((id) => typeof id === "string" && id.length > 0))].sort()) {
    await fenceWorkspace(workspaceId);
    if (erasure.getStore()?.has(workspaceId)) continue;
    const mode = await PrivateWorkspace.findOne({ workspaceId }).lean();
    // Expiry retires disposable preparation atomically with this ordinary write.
    // A failed writer rolls cleanup back; the next writer can retry it safely.
    if (mode && !await discardPrivatePreparation(workspaceId, mode.migrationId, true)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED });
  }
}
