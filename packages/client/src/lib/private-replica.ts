import { openPrivateIndexedStorage } from "./private-indexed-storage";
import { createPrivateAccountInventoryStore, createPrivateDirectoryStore, createPrivateWorkspacePolicyStore, createPrivateWorkspaceReplica, decodeSecret, loadPrivateInitialProjection, PRIVATE_ACCOUNT_INVENTORY_SCOPE, privateReplicaIdentityFromDirectory, signPrivateAccountInventory, signPrivateWorkspacePolicy, type KeyValueStorage, type PrivateAccountWorkspace, type PrivateDirectoryTrust, type PrivateProjectionTransport, type PrivateWorkspacePolicyCheckpoint, type QueueExclusive, type VerifiedPrivateAccountInventory, type VerifiedPrivateDirectory, type VerifiedPrivateProjectionSnapshot } from "@starter/core";
import { privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion, subscribePrivateSession } from "./private-session";
function privateStorageAccess(userId: string, server: string) {
  const root = privateSession(userId);
  if (!root || privateDataOrigin() !== server) return null;
  const check = privateOperationScope(userId), key = decodeSecret(root.master, 32);
  return { key, current: () => {
    try { check(); return privateSession(userId) === root; } catch { return false; }
  }, release: () => key.fill(0) };
}
/** Use the account-wide lock from privateAccountInventoryStorageHost, including
 * when several workspace windows share one encrypted account inventory. */
export async function privateAccountWorkspaceInventoryStore(userId: string, storage: KeyValueStorage, exclusive: QueueExclusive) {
  const root = privateSession(userId), server = privateDataOrigin(), captured = privateOperationScope(userId);
  if (!root) throw new Error("Unlock private data before opening account workspace inventory");
  const check = () => { captured(); if (privateSession(userId) !== root || privateDataOrigin() !== server) throw new Error("Private data changed during this operation"); };
  const { kty, crv, x, y } = root.signingPrivateKey;
  const store = await createPrivateAccountInventoryStore({ server, userId, storage, exclusive, signingPublicKey: { kty, crv, x, y }, resolveStorageKey: () => privateStorageAccess(userId, server), capture: () => { check(); return check; } });
  check(); return store;
}
/** An explicit local enrollment/update, never an automatic response to absent
 * server/local state. A new device normally restores a trusted checkpoint. */
export function signPrivateAccountWorkspaceInventory(userId: string, workspaces: readonly PrivateAccountWorkspace[], previous: VerifiedPrivateAccountInventory | null) {
  const root = privateSession(userId), check = privateOperationScope(userId), server = privateDataOrigin(), version = privateSessionVersion();
  if (!root) throw new Error("Unlock private data before signing account workspace inventory");
  return signPrivateAccountInventory({ server, userId, workspaces, previous, signingPrivateKey: root.signingPrivateKey, current: () => {
    try { check(); return privateSessionVersion() === version && !!privateSession(userId) && privateDataOrigin() === server; } catch { return false; }
  } });
}
/** A trusted activation/device/recovery checkpoint is required. This adapter
 * never treats missing metadata as standard storage or trusts an API mode to
 * pick its initial root. App-wide mode/old-client readiness is still separate. */
export async function privateWorkspacePolicyStore(userId: string, workspaceId: string, storage: KeyValueStorage, exclusive: QueueExclusive, expected: PrivateWorkspacePolicyCheckpoint) {
  const root = privateSession(userId), server = privateDataOrigin(), captured = privateOperationScope(userId);
  if (!root) throw new Error("Unlock private data before opening workspace policy");
  const check = () => { captured(); if (privateSession(userId) !== root || privateDataOrigin() !== server) throw new Error("Private data changed during this operation"); };
  const { kty, crv, x, y } = root.signingPrivateKey;
  const store = await createPrivateWorkspacePolicyStore({ storage, exclusive, scope: { server, userId, workspaceId }, signingPublicKey: { kty, crv, x, y }, expected,
    resolveStorageKey: () => privateStorageAccess(userId, server), capture: () => { check(); return check; },
  }); check(); return store;
}
export function signPrivateWorkspaceDevicePolicy(userId: string, snapshot: VerifiedPrivateProjectionSnapshot, directory: VerifiedPrivateDirectory) {
  const root = privateSession(userId), check = privateOperationScope(userId), server = privateDataOrigin();
  if (!root || snapshot.scope.userId !== userId || snapshot.scope.server !== server) throw new Error("Use this account's current private snapshot");
  return signPrivateWorkspacePolicy({ snapshot, directory, secrets: root, current: () => {
    try { check(); return privateSession(userId) === root && privateDataOrigin() === server; } catch { return false; }
  } });
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

/** The caller supplies a root from trusted activation/device/recovery state.
 * A feed response cannot select or downgrade that root. No public migration
 * controller is mounted yet; this only binds core delivery to the live unlock. */
export function loadPrivateWorkspaceProjection(userId: string, workspaceId: string, directory: VerifiedPrivateDirectory, expectedRoot: string, transport: PrivateProjectionTransport) {
  const server = privateDataOrigin(), root = privateSession(userId), check = privateOperationScope(userId);
  if (!root) throw new Error("Unlock private data before loading workspace projections");
  if (directory.signed.directory.server !== server || directory.signed.directory.workspaceId !== workspaceId) throw new Error("Private directory belongs to another server or workspace");
  return loadPrivateInitialProjection({ transport, expectedRoot, directory, secrets: root, scope: { server, workspaceId, userId }, current: () => {
    try { check(); return privateSession(userId) === root && privateDataOrigin() === server; } catch { return false; }
  } });
}

/** One durable host for both encrypted adapters. Closing/locking never deletes
 * queued work. Reopen after unlocking; stale handles cannot resume a save. */
export function privateWorkspaceStorageHost(userId: string, workspaceId: string) { return privateStorageHost(userId, workspaceId); }
export function privateAccountInventoryStorageHost(userId: string) { return privateStorageHost(userId, PRIVATE_ACCOUNT_INVENTORY_SCOPE); }
async function privateStorageHost(userId: string, workspaceId: string) {
  if (!privateSession(userId)) throw new Error("Unlock private data before opening workspace storage");
  const version = privateSessionVersion();
  const server = privateDataOrigin(), check = privateOperationScope(userId);
  const host = await openPrivateIndexedStorage({ server, userId });
  let unsubscribe = () => {};
  const close = () => { unsubscribe(); host.close(); };
  try {
    check(); if (privateSessionVersion() !== version) throw new Error("Private data changed during this operation");
    const exclusive = host.exclusive(workspaceId);
    unsubscribe = subscribePrivateSession(() => {
      try { check(); if (privateSessionVersion() !== version) close(); } catch { close(); }
    });
    return { storage: host.storage, exclusive, close };
  } catch (error) { close(); throw error; }
}
