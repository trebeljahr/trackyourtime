import { PrivateTimerCheckpointMissingError, PrivateTimerHistoryProofPendingError, type PrivateReplicaRecoveryState } from "@starter/core";
import { privateClientScope } from "./private-client-scope";
import { privateAccountTimerCoordinatorExclusive } from "./private-indexed-storage";
import { privateAccountInventoryStorageHost, privateAccountTimerStorageHost, privateAccountTimerStore } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
type TimerStore = Awaited<ReturnType<typeof privateAccountTimerStore>>;
type CoordinatorCopy = Awaited<ReturnType<typeof import("./private-workspace-session").openPrivateWorkspaceCoordinatorCopy>>;
/** One account/server mutex covers local timer publication and every private
 * view, domain edit and sync. State/workspace locks nest below it, never above
 * it. It owns no keys or decrypted view between calls. Repair never commits
 * network edits; missing copies bootstrap only from their already pinned roots. */
export async function withPrivateAccountTimerGate<T>(userId: string, work: (context: { timer: TimerStore | null; check: () => void }) => Promise<T>, options: { repair?: boolean } = {}) {
  const repair = options.repair !== false;
  const binding = privateClientScope(userId), exclusive = await privateAccountTimerCoordinatorExclusive(binding); binding.check();
  return exclusive(async () => {
    binding.check(); const host = await privateAccountTimerStorageHost(userId), copies = new Map<string, CoordinatorCopy>();
    let inventoryHost: Awaited<ReturnType<typeof privateAccountInventoryStorageHost>> | null = null;
    try {
      const timer = await privateAccountTimerStore(userId, host.storage, host.exclusive), snapshot = await timer.exportRecovery(); binding.check();
      if (snapshot && repair) {
        const packets = [...snapshot.state.committed, ...snapshot.state.pending, ...(snapshot.state.preparing ? [snapshot.state.preparing] : [])];
        if (packets.length) {
          inventoryHost = await privateAccountInventoryStorageHost(userId); binding.check();
          const inventories = await privateAccountWorkspaceInventorySync(userId, inventoryHost.storage, inventoryHost.exclusive), inventory = await inventories.exportRecovery(); binding.check();
          // Repair only policies from this authenticated local copy. An API
          // response cannot choose new workspace roots or recipients here.
          const { openPrivateWorkspaceCoordinatorCopy, privateWorkspaceJournalTransport } = await import("./private-workspace-session"); binding.check();
          for (const packet of packets) {
            const permit = await timer.stagingPermit(packet.signed.header.operationId); binding.check();
            if (!permit) throw new Error("Keep the original account timer plan before opening private data");
            for (const edit of packet.edits) {
              const workspaceId = edit.edit.workspaceId;
              let copy = copies.get(workspaceId);
              if (!copy) {
                const row = inventory.local.inventory.workspaces.find(row => row.workspaceId === workspaceId);
                if (!row || row.mode !== "encrypted") throw new Error("Timer recovery is missing its trusted workspace policy");
                copy = await openPrivateWorkspaceCoordinatorCopy(userId, workspaceId, row.signedPolicy); copies.set(workspaceId, copy); binding.check();
                await copy.pinCoordinatedReceipts(packets.filter(packet => packet.edits.some(edit => edit.edit.workspaceId === workspaceId)).map(packet => packet.signed.header.operationId)); binding.check();
              }
              const checkpoint = await copy.checkpoint(); binding.check();
              if (checkpoint.revision > edit.edit.expectedRevision + 1) {
                const proof = await copy.recoverCoordinatedReceipt(permit, privateWorkspaceJournalTransport(userId, workspaceId)); binding.check();
                if (proof.next !== null) throw new PrivateTimerHistoryProofPendingError();
              }
              await copy.stageCoordinated(permit); binding.check();
            }
            if (snapshot.state.preparing?.signed.header.operationId === packet.signed.header.operationId) { await timer.publish(permit); binding.check(); }
          }
        }
      }
      const result = await work({ timer: snapshot ? timer : null, check: binding.check }); binding.check(); return result;
    } finally { for (const copy of copies.values()) copy.close(); inventoryHost?.close(); host.close(); }
  });
}
type PrivateCopy = { scope: { userId: string }; check: () => void; exportRecovery: () => Promise<PrivateReplicaRecoveryState> };
/** Older private copies without timer state can still do non-clock work. A
 * coordinator-marked copy never falls back to that legacy path after pin loss. */
export async function assertPrivateWorkspaceTimerPin(copy: PrivateCopy, timer: TimerStore | null) {
  copy.check();
  if (!timer) {
    const state = await copy.exportRecovery();
    if (state.pending.some(row => row.coordinatorId) || state.coordinatedReceipts?.length || state.coordinatedProofs?.length || state.coordinatedReceiptPins?.length) throw new PrivateTimerCheckpointMissingError();
  }
  copy.check();
}
export async function withPrivateWorkspaceTimerGate<T>(copy: PrivateCopy, work: () => Promise<T>) {
  copy.check();
  return withPrivateAccountTimerGate(copy.scope.userId, async ({ timer }) => {
    await assertPrivateWorkspaceTimerPin(copy, timer);
    const value = await work(); copy.check(); return value;
  });
}
