import { TRPCError } from "@trpc/server";
import { PrivateMigrationReceipt, PrivateSourceChallengeRequest, PrivateProjectionRoot, PrivateProjectionReader, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";

export function requireActivePrivatePreparation(mode: { state: string; revision: number; head: string | null; leaseUntil: Date; backupVerified: boolean }, now = Date.now()): void {
  if (mode.state !== "migrating" || mode.revision !== 0 || mode.head || mode.backupVerified || !Number.isFinite(mode.leaseUntil.getTime()) || mode.leaseUntil.getTime() <= now) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Migration preparation expired or is no longer writable. Original data was kept." });
}
/** Internal cleanup, always fenced against staging and cutover. Deletes only
 * disposable preparation ciphertext/receipts. Original collections, user-held
 * files, public directory history and encrypted workspaces are never removed.
 * Authentication for explicit cancellation belongs to its outer controller. */
export async function discardPrivatePreparation(workspaceId: string, migrationId: string, expiredOnly = false, now = Date.now()): Promise<boolean> {
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, state: "migrating", revision: 0, head: null, backupVerified: false }).lean();
    if (!mode || (expiredOnly && mode.leaseUntil.getTime() > now)) return false;
    if (await PrivateWorkspaceCommit.exists({ workspaceId })) throw new TRPCError({ code: "CONFLICT", message: "Preparation has unexpected committed history. Data was kept for recovery." });
    await PrivateRecord.deleteMany({ workspaceId });
    await PrivateSnapshotChunk.deleteMany({ workspaceId, migrationId });
    await PrivateSnapshotReader.deleteMany({ workspaceId, migrationId });
    await PrivateProjectionReader.deleteMany({ workspaceId, migrationId });
    await PrivateProjectionRoot.deleteMany({ workspaceId, migrationId });
    await PrivateMigrationReceipt.deleteMany({ workspaceId, migrationId });
    await PrivateSourceChallengeRequest.deleteMany({ workspaceId });
    await PrivateWorkspace.deleteOne({ _id: mode._id });
    return true;
  });
}
