import { accountWorkspacePolicy, canonicalJson, verifyPrivateWorkspaceRecoveryArchive, createPrivateDirectoryStore, createPrivateWorkspacePolicyStore, createPrivateWorkspaceReplica, decodeSecret, loadPrivateDirectoryCheckpoint, loadPrivateInitialProjection, privateReplicaIdentityFromDirectory, requirePrivateWorkspacePolicy, type PrivateDirectoryTransport, type PrivateProjectionTransport, type PrivateRecoveryIdentity, type SignedPrivateWorkspacePolicy, type PrivateKind, type PrivateReplicaTransport, PRIVATE_FAVORITE_EDIT_KINDS, privateFavoriteEdit, type PrivateFavoriteEditPath, PRIVATE_CATALOG_EDIT_KINDS, privateCatalogEdit, type PrivateCatalogEditPath, PRIVATE_ENTRY_EDIT_KINDS, privateEntryEdit, preparePrivateEntryIntent, privateSettingsEdit, PRIVATE_SETTINGS_EDIT_KINDS, privateBusinessProfileEdit, PRIVATE_BUSINESS_PROFILE_EDIT_KINDS, type PrivateBusinessProfileEditPath, privateMemberRateEdit, PRIVATE_MEMBER_RATE_EDIT_KINDS, type PrivateEntryEditPath, privateInvoiceEdit, PRIVATE_INVOICE_EDIT_KINDS, type PrivateInvoiceEditPath } from "@starter/core";
import { privateSession } from "./private-session";
import { privateClientScope } from "./private-client-scope";
import { privateScopedRpc } from "./private-scoped-rpc";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountInventoryStorageHost, privateWorkspaceStorageHost, privateAccountTimerStorageHost, privateAccountTimerStore } from "./private-replica";
import type { PrivateTimerStagePermit } from "@starter/core";
import { assertPrivateWorkspaceTimerPin, withPrivateAccountTimerGate, withPrivateWorkspaceTimerGate } from "./private-account-timer-coordinator";

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
      scope, policy, directory: verifiedDirectory, current, check: assertPolicy, close,
      exportRecovery: async () => { assertPolicy(); const value = await replica.exportRecovery(); assertPolicy(); return value; },
      read: async () => { assertPolicy(); const value = await replica.read(); assertPolicy(); return value; },
      readKinds: async (kinds: readonly PrivateKind[]) => { assertPolicy(); const value = await replica.readKinds(kinds); assertPolicy(); return value; },
      checkpoint: async () => { assertPolicy(); const value = await replica.checkpoint(); assertPolicy(); return value; },
      status: async () => { assertPolicy(); const value = await replica.status(); assertPolicy(); return value; },
      prepareTail: async () => { assertPolicy(); const value = await replica.prepareTail(); assertPolicy(); return value; },
      stageCoordinated: async (permit: PrivateTimerStagePermit) => { assertPolicy(); const value = await replica.stageCoordinated(permit); assertPolicy(); return value; },
      pinCoordinatedReceipts: async (operationIds: readonly string[]) => { const captured = [...operationIds]; assertPolicy(); await replica.pinCoordinatedReceipts(captured); assertPolicy(); },
      recoverCoordinatedReceipt: async (permit: PrivateTimerStagePermit, transport: PrivateReplicaTransport) => { assertPolicy(); const value = await replica.recoverCoordinatedReceipt(permit, transport); assertPolicy(); return value; },
      coordinatedReceipt: async (permit: PrivateTimerStagePermit) => { assertPolicy(); const value = await replica.coordinatedReceipt(permit); assertPolicy(); return value; },
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
      editMemberRate: async (input: unknown) => {
        const frozen = structuredClone(input); assertPolicy();
        const result = await replica.transact(PRIVATE_MEMBER_RATE_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateMemberRateEdit({ scope, directory, records, current, input: frozen });
        }); assertPolicy(); return result;
      },
      editSettings: async (input: unknown, preferences: unknown) => {
        const frozen = structuredClone(input), rendering = structuredClone(preferences); assertPolicy();
        const result = await replica.transact(PRIVATE_SETTINGS_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateSettingsEdit({ scope, directory, records, current, input: frozen, preferences: rendering });
        }); assertPolicy(); return result;
      },
      editBusinessProfile: async (path: PrivateBusinessProfileEditPath, input: unknown) => {
        const frozen = structuredClone(input); assertPolicy();
        const result = await replica.transact(PRIVATE_BUSINESS_PROFILE_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateBusinessProfileEdit({ scope, directory, records, current, path, input: frozen });
        }); assertPolicy(); return result;
      },
      editInvoice: async (path: PrivateInvoiceEditPath, input: unknown, preferences: unknown) => {
        const frozen = structuredClone(input), rendering = structuredClone(preferences); assertPolicy();
        const result = await replica.transact(PRIVATE_INVOICE_EDIT_KINDS, ({ records, directory }) => {
          assertPolicy(); return privateInvoiceEdit({ scope, directory, records, current, path, input: frozen, preferences: rendering });
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

/** Internal only: the caller holds the independent account timer gate. Recovery
 * may supply an authenticated local policy even while inventory sync conflicts.
 * Ordinary SDK views and edits must use the guarded public sessions below. */
export function openPrivateWorkspaceCoordinatorCopy(userId: string, workspaceId: string, policy?: SignedPrivateWorkspacePolicy) {
  return openPrivateWorkspaceCopy(userId, workspaceId, policy);
}
function openGuardedCopy(userId: string, workspaceId: string) {
  return withPrivateAccountTimerGate(userId, async ({ timer }) => {
    const copy = await openPrivateWorkspaceCopy(userId, workspaceId);
    try { await assertPrivateWorkspaceTimerPin(copy, timer); return copy; }
    catch (error) { copy.close(); throw error; }
  });
}

/** Active reads retain inventory conflict refusal. Raw recovery capture is a
 * separate path and cannot be used to select an active plaintext adapter. */
export async function openPrivateWorkspaceSession(userId: string, workspaceId: string) {
  const copy = await openGuardedCopy(userId, workspaceId);
  return { scope: copy.scope, policy: copy.policy, directory: copy.directory, current: copy.current, close: copy.close,
    read: () => withPrivateWorkspaceTimerGate(copy, copy.read),
    readKinds: (kinds: readonly PrivateKind[]) => { const captured = [...kinds]; return withPrivateWorkspaceTimerGate(copy, () => copy.readKinds(captured)); },
    checkpoint: () => withPrivateWorkspaceTimerGate(copy, copy.checkpoint),
  };
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
  const copy = await openGuardedCopy(userId, workspaceId);
  try {
    const transport = privateWorkspaceJournalTransport(userId, workspaceId);
    const run = <T>(work: () => Promise<T>) => withPrivateWorkspaceTimerGate(copy, work);
    return { scope: copy.scope, current: copy.current, close: copy.close, checkpoint: () => run(copy.checkpoint), status: () => run(copy.status),
      editFavorite: (path: PrivateFavoriteEditPath, input: unknown) => { const captured = structuredClone(input); return run(() => copy.editFavorite(path, captured)); },
      editCatalog: (path: PrivateCatalogEditPath, input: unknown) => { const captured = structuredClone(input); return run(() => copy.editCatalog(path, captured)); },
      editEntry: (path: PrivateEntryEditPath, input: unknown, intentId?: string) => { const captured = structuredClone(input); return run(() => copy.editEntry(path, captured, intentId)); },
      editSettings: (input: unknown, preferences: unknown) => { const captured = structuredClone(input), display = structuredClone(preferences); return run(() => copy.editSettings(captured, display)); },
      editBusinessProfile: (path: PrivateBusinessProfileEditPath, input: unknown) => { const captured = structuredClone(input); return run(() => copy.editBusinessProfile(path, captured)); },
      editInvoice: (path: PrivateInvoiceEditPath, input: unknown, preferences: unknown) => { const captured = structuredClone(input), rendering = structuredClone(preferences); return run(() => copy.editInvoice(path, captured, rendering)); },
      editMemberRate: (input: unknown) => { const captured = structuredClone(input); return run(() => copy.editMemberRate(captured)); },
      pull: (through?: number) => run(() => copy.pull(transport, through)), flushOne: () => run(() => copy.flushOne(transport)),
    };
  } catch (error) { copy.close(); throw error; }
}
/** Capture includes exact pending packets and inventory conflicts without
 * replaying them. Private pins are immutable, so a profile reread can be paired
 * with the workspace snapshot only while its activation policy stays identical. */
export function capturePrivateWorkspaceRecovery(userId: string, workspaceId: string, identity: PrivateRecoveryIdentity) {
  const captured = structuredClone(identity);
  return withPrivateAccountTimerGate(userId, () => capturePrivateWorkspaceRecoveryCopy(userId, workspaceId, captured), { repair: false });
}
async function capturePrivateWorkspaceRecoveryCopy(userId: string, workspaceId: string, identity: PrivateRecoveryIdentity) {
  const binding = privateClientScope(userId), host = await privateAccountInventoryStorageHost(userId);
  let copy: Awaited<ReturnType<typeof openPrivateWorkspaceCopy>> | null = null;
  let timerHost: Awaited<ReturnType<typeof privateAccountTimerStorageHost>> | null = null;
  try {
    binding.check();
    timerHost = await privateAccountTimerStorageHost(userId); binding.check();
    const timers = await privateAccountTimerStore(userId, timerHost.storage, timerHost.exclusive), timerBefore = await timers.exportRecovery(); binding.check();
    const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), before = await inventories.exportRecovery(); binding.check();
    const row = before.local.inventory.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!row || row.mode !== "encrypted") throw new Error("Private recovery needs this workspace's trusted encrypted policy");
    copy = await openPrivateWorkspaceCopy(userId, workspaceId, row.signedPolicy); binding.check();
    const replica = await copy.exportRecovery(), inventory = await inventories.exportRecovery(); binding.check();
    await assertPrivateWorkspaceTimerPin(copy, timerBefore ? timers : null); binding.check();
    const after = inventory.local.inventory.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!after || after.mode !== "encrypted" || canonicalJson(after.signedPolicy.policy) !== canonicalJson(row.signedPolicy.policy)) throw new Error("Private workspace policy changed during recovery capture");
    const timerAfter = await timers.exportRecovery(); binding.check();
    if ((timerBefore?.digest ?? null) !== (timerAfter?.digest ?? null)) throw new Error("Account timer changed during recovery capture");
    return await verifyPrivateWorkspaceRecoveryArchive({ ...(timerBefore ? { format: "trackyourtime-private-workspace-recovery-v2", accountTimer: timerBefore.state } : { format: "trackyourtime-private-workspace-recovery-v1" }), server: binding.server, userId, workspaceId, createdAt: new Date().toISOString(), identity: { publicKey: identity.publicKey, signingPublicKey: identity.signingPublicKey, recovery: identity.recovery }, inventory, directory: { signed: copy.directory.signed, digest: copy.directory.digest }, replica }, privateSession(userId)!, binding.current);
  } finally { copy?.close(); timerHost?.close(); host.close(); }
}
