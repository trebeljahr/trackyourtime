import { PrivateAccountInventoryMissingError } from "@starter/core";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateClientScope } from "./private-client-scope";
/** Backup presentation only, never authority for content routing or writes.
 * Existing unenrolled users retain standard backup controls. Errors and unknown
 * workspaces fail closed. Conflicts may still export the preserved local copy. */
export async function privateRecoveryMode(userId: string, workspaceId: string): Promise<"encrypted" | "standard" | "unenrolled"> {
  const binding = privateClientScope(userId), host = await privateAccountInventoryStorageHost(userId);
  try {
    const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive);
    let value;
    try { value = await inventories.exportRecovery(); }
    catch (error) { binding.check(); if (error instanceof PrivateAccountInventoryMissingError) return "unenrolled"; throw error; }
    binding.check(); const row = value.local.inventory.workspaces.find((item) => item.workspaceId === workspaceId);
    if (!row) throw new Error("Workspace is absent from trusted private backup inventory");
    return row.mode;
  } finally { host.close(); }
}
