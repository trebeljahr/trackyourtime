import { verifyCombinedWorkspaceRecoveryArchive } from "@starter/core";
import { withBusinessTransaction } from "../business-transaction.js";
import { workspaceRecovery } from "./recovery.js";
import { workspaceRecoverySupplement } from "./recovery-supplement.js";
/** Internal owner-readable capture from one consistent database snapshot. Public standard-mode backups use the separate
 * session/root-authorized source challenge controller. Migration source access
 * remains internal and guarded; never return this capture without authorization. */
export function combinedWorkspaceRecovery(workspaceId: string, ownerId: string, server: string) {
  return withBusinessTransaction(async () => {
    const snapshot = await workspaceRecovery(workspaceId, ownerId);
    const supplement = await workspaceRecoverySupplement(workspaceId, ownerId);
    return verifyCombinedWorkspaceRecoveryArchive({ format: "trackyourtime-workspace-recovery-v2", server, ownerId, snapshot, supplement }, { server, ownerId, workspaceId });
  });
}
