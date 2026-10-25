import { verifyCombinedWorkspaceRecoveryArchive } from "@starter/core";
import { withBusinessTransaction } from "../business-transaction.js";
import { workspaceRecovery } from "./recovery.js";
import { workspaceRecoverySupplement } from "./recovery-supplement.js";
/** Internal owner-readable capture from one consistent database snapshot. No
 * public endpoint is mounted: sensitive original reads still need the verified
 * migration controller's authorization before a future client can request it. */
export function combinedWorkspaceRecovery(workspaceId: string, ownerId: string, server: string) {
  return withBusinessTransaction(async () => {
    const snapshot = await workspaceRecovery(workspaceId, ownerId);
    const supplement = await workspaceRecoverySupplement(workspaceId, ownerId);
    return verifyCombinedWorkspaceRecoveryArchive({ format: "trackyourtime-workspace-recovery-v2", server, ownerId, snapshot, supplement }, { server, ownerId, workspaceId });
  });
}
