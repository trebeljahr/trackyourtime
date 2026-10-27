import { accountWorkspacePolicy, canonicalJson, verifyPrivateWorkspaceRecoveryArchive, createPrivateDirectoryStore, createPrivateWorkspacePolicyStore, createPrivateWorkspaceReplica, decodeSecret, loadPrivateDirectoryCheckpoint, loadPrivateInitialProjection, privateReplicaIdentityFromDirectory, requirePrivateWorkspacePolicy, type PrivateDirectoryTransport, type PrivateProjectionTransport, type PrivateRecoveryIdentity, type SignedPrivateWorkspacePolicy, type PrivateKind, type PrivateReplicaTransport, PRIVATE_FAVORITE_EDIT_KINDS, privateFavoriteEdit, type PrivateFavoriteEditPath, PRIVATE_CATALOG_EDIT_KINDS, privateCatalogEdit, type PrivateCatalogEditPath, PRIVATE_ENTRY_EDIT_KINDS, privateEntryEdit, preparePrivateEntryIntent, type PrivateEntryEditPath } from "@starter/core";
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
async function openPrivateWorkspaceCopy(userId: string, workspaceId: string, recoveryPolicy?: SignedPrivateWorkspacePolicy) {
  const binding = privateClientScope(userId), scope = Object.freeze({ server: binding.server, userId, workspaceId });
  let closed = false;
  const check = () => { binding.check(); if (closed) throw new Error("Private workspace session was closed"); };
  const current = () => !closed && binding.current();
  const inventoryHost = recoveryPolicy ? null : await privateAccountInventoryStorageHost(userId);
  let host: Awaited<ReturnType<typeof privateWorkspaceStorageHost>> | null = null;
  try {
    check();
    let signedPolicy = recoveryPolicy;
    if (!signedPolicy) {
      const inventories = await privateAccountWorkspaceInventorySync(userId, inventoryHost!.storage, inventoryHost!.exclusive);
      const profile = await inventories.read(); check();
      const row = accountWorkspacePolicy(profile.inventory, scope, workspaceId);
      if (row.mode !== "encrypted") throw new Error("This workspace has no trusted encrypted storage policy");
      signedPolicy = row.signedPolicy;
    }
    const pin = signedPolicy.policy;
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
    const policy = await policies.accept(signedPolicy); check();
    const assertPolicy = () => { check(); requirePrivateWorkspacePolicy(policy, scope, "encrypted"); };
    const replicaOptions = { scope, storage: host.storage, exclusive: host.exclusive, resolveStorageKey, resolveIdentity: () => {
      assertPolicy(); return privateReplicaIdentityFromDirectory(verifiedDirectory, userId, privateSession(userId)!, current);
    } };
    const legacy = await createPrivateWorkspaceReplica(replicaOptions), legacyCheckpoint = await legacy.checkpoint(); assertPolicy();
    let replica = await createPrivateWorkspaceReplica({ ...replicaOptions, storageKey: `replica:${pin.activationRoot}` });
    let checkpoint = await replica.checkpoint(); assertPolicy();
    if (legacyCheckpoint.revision || legacyCheckpoint.pending || legacyCheckpoint.head) {
      if (checkpoint.revision || checkpoint.pending || checkpoint.head) throw new Error("Two private history copies need review; both were kept");
      // Never ignore unsent work left by an earlier adapter. It remains the
      // authoritative slot until an explicit migration/recovery replaces it.
      replica = legacy; checkpoint = legacyCheckpoint;
    }
    if (checkpoint.revision === 0 || (checkpoint.revision === 1 && !checkpoint.activationRoot && checkpoint.head === pin.activationRoot)) {
      const snapshot = await loadPrivateInitialProjection({ scope, expectedRoot: pin.activationRoot, directory: verifiedDirectory, secrets: privateSession(userId)!, current, transport: transport.projection }); assertPolicy();
      await replica.bootstrapProjection(snapshot); assertPolicy(); checkpoint = await replica.checkpoint();
    }
    if (checkpoint.activationRoot !== pin.activationRoot) throw new Error("Stored private history has no matching activation checkpoint; keep or recover it before opening");
    const ownedHost = host;
    const close = () => { closed = true; ownedHost.close(); };
    return {
      scope, policy, directory: verifiedDirectory, current, close,
      exportRecovery: async () => { assertPolicy(); const value = await replica.exportRecovery(); assertPolicy(); return value; },
      read: async () => { assertPolicy(); const value = await replica.read(); assertPolicy(); return value; },
      readKinds: async (kinds: readonly PrivateKind[]) => { assertPolicy(); const value = await replica.readKinds(kinds); assertPolicy(); return value; },
      checkpoint: async () => { assertPolicy(); const value = await replica.checkpoint(); assertPolicy(); return value; },
      status: async () => { assertPolicy(); const value = await replica.status(); assertPolicy(); return value; },
      editFavorite: async (path: PrivateFavoriteEditPath, input: unknown) => {
        const frozen = structuredClone(input); assertPolicy();
        const result = await replica.transact(PRIVATE_FAVORITE_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateFavoriteEdit({ scope, directory, records, current, path, input: frozen });
        }); assertPolicy(); return result;
      },
      editCatalog: async (path: PrivateCatalogEditPath, input: unknown) => {
        const frozen = structuredClone(input); assertPolicy();
        const result = await replica.transact(PRIVATE_CATALOG_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateCatalogEdit({ scope, directory, records, current, path, input: frozen });
        }); assertPolicy(); return result;
      },
      editEntry: async (path: PrivateEntryEditPath, input: unknown, intentId?: string) => {
        const frozen = structuredClone(input); assertPolicy();
        const intent = intentId === undefined ? undefined : await preparePrivateEntryIntent({ scope, path, input: frozen, intentId, current }); assertPolicy();
        const result = await replica.transact(PRIVATE_ENTRY_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateEntryEdit({ scope, directory, records, current, path, input: frozen, intent });
        }); assertPolicy(); return result;
      },
      pull: async (transport: PrivateReplicaTransport, through?: number) => { assertPolicy(); const result = await replica.pull(transport, through); assertPolicy(); return result; },
      flushOne: async (transport: PrivateReplicaTransport) => { assertPolicy(); const result = await replica.flushOne(transport); assertPolicy(); return result; },
    };
  } catch (error) { closed = true; host?.close(); throw error; }
  finally { inventoryHost?.close(); }
}

/** Active reads retain inventory conflict refusal. Raw recovery capture is a
 * separate path and cannot be used to select an active plaintext adapter. */
export async function openPrivateWorkspaceSession(userId: string, workspaceId: string) {
  const copy = await openPrivateWorkspaceCopy(userId, workspaceId);
  return { scope: copy.scope, policy: copy.policy, directory: copy.directory, current: copy.current, close: copy.close, read: copy.read, readKinds: copy.readKinds, checkpoint: copy.checkpoint };
}
/** This transport carries signed ciphertext only and never falls back to the
 * old unchained routes. Public server write/rollout guards remain independent. */
export function privateWorkspaceJournalTransport(userId: string, workspaceId: string): PrivateReplicaTransport {
  const { rpc, supported } = privateScopedRpc(userId, "privacy.historyChain", 20_000);
  const obsolete = async (): Promise<never> => { throw new Error("Unchained workspace transport is disabled"); };
  return { commit: obsolete, changes: obsolete,
    chainedCommit: async (input) => { supported(); const result = await rpc.privacy.chainedWrite.mutate({ ...input, workspaceId }); supported(); return result; },
    chainedChanges: async (input) => { supported(); const result = await rpc.privacy.chainedChanges.query({ ...input, workspaceId }); supported(); return result; },
  };
}
/** Separate write/sync facade. Domain intent is validated and durably saved
 * inside the replica lock. A local result is not a server sync receipt. */
export async function openPrivateWorkspaceSyncSession(userId: string, workspaceId: string) {
  const copy = await openPrivateWorkspaceCopy(userId, workspaceId);
  try {
    const transport = privateWorkspaceJournalTransport(userId, workspaceId);
    return { scope: copy.scope, current: copy.current, close: copy.close, checkpoint: copy.checkpoint, status: copy.status,
      editFavorite: copy.editFavorite, editCatalog: copy.editCatalog, editEntry: copy.editEntry,
      pull: (through?: number) => copy.pull(transport, through), flushOne: () => copy.flushOne(transport),
    };
  } catch (error) { copy.close(); throw error; }
}
/** Capture includes exact pending packets and inventory conflicts without
 * replaying them. Private pins are immutable, so a profile reread can be paired
 * with the workspace snapshot only while its activation policy stays identical. */
export async function capturePrivateWorkspaceRecovery(userId: string, workspaceId: string, identity: PrivateRecoveryIdentity) {
  const binding = privateClientScope(userId), host = await privateAccountInventoryStorageHost(userId);
  let copy: Awaited<ReturnType<typeof openPrivateWorkspaceCopy>> | null = null;
  try {
    binding.check();
    const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), before = await inventories.exportRecovery(); binding.check();
    const row = before.local.inventory.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!row || row.mode !== "encrypted") throw new Error("Private recovery needs this workspace's trusted encrypted policy");
    copy = await openPrivateWorkspaceCopy(userId, workspaceId, row.signedPolicy); binding.check();
    const replica = await copy.exportRecovery(), inventory = await inventories.exportRecovery(); binding.check();
    const after = inventory.local.inventory.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!after || after.mode !== "encrypted" || canonicalJson(after.signedPolicy.policy) !== canonicalJson(row.signedPolicy.policy)) throw new Error("Private workspace policy changed during recovery capture");
    return await verifyPrivateWorkspaceRecoveryArchive({ format: "trackyourtime-private-workspace-recovery-v1", server: binding.server, userId, workspaceId, createdAt: new Date().toISOString(), identity: { publicKey: identity.publicKey, signingPublicKey: identity.signingPublicKey, recovery: identity.recovery }, inventory, directory: { signed: copy.directory.signed, digest: copy.directory.digest }, replica }, privateSession(userId)!, binding.current);
  } finally { copy?.close(); host.close(); }
}
