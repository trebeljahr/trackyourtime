import { createPrivateDirectoryStore, createPrivateWorkspaceReplica, decodeSecret, privateReplicaIdentityFromDirectory, type KeyValueStorage, type PrivateDirectoryTrust, type QueueExclusive, type VerifiedPrivateDirectory } from "@starter/core";
import { privateDataOrigin, privateOperationScope, privateSession } from "./private-session";
function privateStorageAccess(userId: string, server: string) {
  const root = privateSession(userId);
  if (!root || privateDataOrigin() !== server) return null;
  const check = privateOperationScope(userId), key = decodeSecret(root.master, 32);
  return { key, current: () => {
    try { check(); return privateSession(userId) === root; } catch { return false; }
  }, release: () => key.fill(0) };
}
/** Hosts supply the same account/workspace Web Lock to both adapters. A trusted
 * owner key comes from the unlocked identity or an independently checked invite. */
export function privateDirectoryStore(userId: string, workspaceId: string, storage: KeyValueStorage, exclusive: QueueExclusive, initialOwner: Pick<PrivateDirectoryTrust, "ownerId" | "signingPublicKey">) {
  const server = privateDataOrigin();
  return createPrivateDirectoryStore({ storage, scope: { server, userId, workspaceId }, initialOwner, exclusive, resolveStorageKey: () => privateStorageAccess(userId, server), capture: () => privateOperationScope(userId) });
}
/** An API response cannot choose recipients for this adapter. Its directory was
 * verified separately. Changing it invalidates an in-flight read or write. */
export function privateWorkspaceReplica(userId: string, workspaceId: string, storage: KeyValueStorage, exclusive: QueueExclusive, directory: () => VerifiedPrivateDirectory | null) {
  const server = privateDataOrigin();
  return createPrivateWorkspaceReplica({ storage, scope: { server, userId, workspaceId }, exclusive, resolveStorageKey: () => privateStorageAccess(userId, server), resolveIdentity: () => {
    const root = privateSession(userId), verified = directory();
    if (!root || !verified || privateDataOrigin() !== server) return null;
    if (verified.signed.directory.server !== server || verified.signed.directory.workspaceId !== workspaceId) throw new Error("Private directory belongs to another server or workspace");
    const check = privateOperationScope(userId);
    return privateReplicaIdentityFromDirectory(verified, userId, root, () => {
      try { check(); return privateSession(userId) === root && directory()?.digest === verified.digest; } catch { return false; }
    });
  } });
}
