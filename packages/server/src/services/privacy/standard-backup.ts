import { TRPCError } from "@trpc/server";
import type { SignedPrivateSourceChallenge } from "@starter/shared";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { createPrivateSourceChallenge, readPrivateMigrationOriginals } from "./source-challenges.js";
type Scope = { server: string; userId: string; workspaceId: string; sessionId: string };
async function standardOnly<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    if (await PrivateWorkspace.exists({ workspaceId: scope.workspaceId })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Original-data backups are available only for standard workspaces. Existing backups were kept." });
    return work();
  });
}
/** Standard-mode user backup only. Never permits preparation/private reads or
 * conversion. Scope comes exclusively from authenticated request context. */
export function createStandardBackupChallenge(input: Scope) {
  const scope = { ...input };
  return standardOnly(scope, () => createPrivateSourceChallenge({ ...scope, purpose: "workspace-originals", migrationId: null }));
}
export function readStandardBackupOriginals(input: Scope, proof: SignedPrivateSourceChallenge) {
  const scope = { ...input };
  return standardOnly(scope, () => readPrivateMigrationOriginals({ ...scope, purpose: "workspace-originals", migrationId: null }, proof));
}
