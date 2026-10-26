import { accountWorkspacePolicy, createPrivateDirectoryStore, createPrivateWorkspacePolicyStore, createPrivateWorkspaceReplica, decodeSecret, loadPrivateDirectoryCheckpoint, loadPrivateInitialProjection, privateReplicaIdentityFromDirectory, requirePrivateWorkspacePolicy, type PrivateDirectoryTransport, type PrivateProjectionTransport } from "@starter/core";
import { privateSession } from "./private-session";
import { privateClientScope } from "./private-client-scope";
import { privateScopedRpc } from "./private-scoped-rpc";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountInventoryStorageHost, privateWorkspaceStorageHost } from "./private-replica";

export function privateWorkspaceProjectionTransport(userId: string, workspaceId: string): { directory: PrivateDirectoryTransport; projection: PrivateProjectionTransport } {
  const { rpc, supported } = privateScopedRpc(userId, "privacy.readerProjections");
  return {
    directory: { page: async (input) => { supported(); const result = await rpc.privacy.projectionDirectory.mutate({ workspaceId, after: input.after, through: input.through }); supported(); return result; } },
    projection: {
      root: async () => { supported(); const result = await rpc.privacy.projectionRoot.mutate({ workspaceId }); supported(); return result; },
      page: async (input) => { supported(); const result = await rpc.privacy.projectionPage.mutate({ workspaceId, migrationId: input.migrationId, lane: input.lane, offset: input.offset }); supported(); return result; },
    },
  };
}
/** Read-only client composition. The account inventory is independently
 * enrolled/restored beforehand. Its signed policy selects the directory and
 * activation root; server metadata cannot select an adapter or replace pins.
 * Active app routing and content writes are mounted separately. */
export async function openPrivateWorkspaceSession(userId: string, workspaceId: string) {
  const binding = privateClientScope(userId), scope = Object.freeze({ server: binding.server, userId, workspaceId });
  let closed = false;
  const check = () => { binding.check(); if (closed) throw new Error("Private workspace session was closed"); };
  const current = () => !closed && binding.current();
  const inventoryHost = await privateAccountInventoryStorageHost(userId);
  let host: Awaited<ReturnType<typeof privateWorkspaceStorageHost>> | null = null;
  try {
    check();
    const inventories = await privateAccountWorkspaceInventorySync(userId, inventoryHost.storage, inventoryHost.exclusive);
    const profile = await inventories.read(); check();
    const row = accountWorkspacePolicy(profile.inventory, scope, workspaceId);
    if (row.mode !== "encrypted") throw new Error("This workspace has no trusted encrypted storage policy");
    const pin = row.signedPolicy.policy;
    host = await privateWorkspaceStorageHost(userId, workspaceId); check();
    const resolveStorageKey = () => {
      check(); const key = decodeSecret(privateSession(userId)!.master, 32);
      return { key, current, release: () => key.fill(0) };
    };
    const capture = () => { check(); return check; };
    const directories = await createPrivateDirectoryStore({ scope, storage: host.storage, exclusive: host.exclusive, capture, resolveStorageKey, initialOwner: { ownerId: pin.ownerId, signingPublicKey: pin.ownerSigningPublicKey } });
    const transport = privateWorkspaceProjectionTransport(userId, workspaceId);
    let directory = await directories.read(); check();
    if (!directory || directory.trust.revision < pin.directoryRevision) {
      const checkpoint = await loadPrivateDirectoryCheckpoint({ scope, expected: { ownerId: pin.ownerId, signingPublicKey: pin.ownerSigningPublicKey, revision: pin.directoryRevision, digest: pin.directoryDigest }, current, transport: transport.directory });
      directory = await directories.restoreCheckpoint(checkpoint); check();
    }
    if (directory.digest !== pin.directoryDigest) throw new Error("Workspace sharing differs from its trusted activation directory; keep this copy for review");
    const verifiedDirectory = directory, { kty, crv, x, y } = privateSession(userId)!.signingPrivateKey;
    const policies = await createPrivateWorkspacePolicyStore({ scope, storage: host.storage, exclusive: host.exclusive, resolveStorageKey, capture, signingPublicKey: { kty, crv, x, y }, expected: { activationRoot: pin.activationRoot, directoryDigest: pin.directoryDigest } });
    const policy = await policies.accept(row.signedPolicy); check();
    const assertPolicy = () => { check(); requirePrivateWorkspacePolicy(policy, scope, "encrypted"); };
    const replica = await createPrivateWorkspaceReplica({ scope, storage: host.storage, exclusive: host.exclusive, resolveStorageKey, resolveIdentity: () => {
      assertPolicy(); return privateReplicaIdentityFromDirectory(verifiedDirectory, userId, privateSession(userId)!, current);
    } });
    let checkpoint = await replica.checkpoint(); assertPolicy();
    if (checkpoint.revision === 0 || (checkpoint.revision === 1 && !checkpoint.activationRoot && checkpoint.head === pin.activationRoot)) {
      const snapshot = await loadPrivateInitialProjection({ scope, expectedRoot: pin.activationRoot, directory: verifiedDirectory, secrets: privateSession(userId)!, current, transport: transport.projection }); assertPolicy();
      await replica.bootstrapProjection(snapshot); assertPolicy(); checkpoint = await replica.checkpoint();
    }
    if (checkpoint.activationRoot !== pin.activationRoot) throw new Error("Stored private history has no matching activation checkpoint; keep or recover it before opening");
    const ownedHost = host;
    const close = () => { closed = true; ownedHost.close(); };
    return {
      scope, policy, directory: verifiedDirectory, current, close,
      read: async () => { assertPolicy(); const value = await replica.read(); assertPolicy(); return value; },
      checkpoint: async () => { assertPolicy(); const value = await replica.checkpoint(); assertPolicy(); return value; },
    };
  } catch (error) { closed = true; host?.close(); throw error; }
  finally { inventoryHost.close(); }
}
