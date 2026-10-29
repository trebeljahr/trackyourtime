import { canonicalJson, privateRecordDigest, PrivateAccountInventoryMissingError } from "@starter/core";
import { privateDeviceWorkspaceTrustSchema, type PrivateDeviceWorkspaceTrust } from "@starter/shared";
import { privateClientScope } from "./private-client-scope";
import { privateAccountInventoryStorageHost, privateAccountTimerStorageHost, privateAccountTimerStore } from "./private-replica";
import { privateAccountInventoryTransport, privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateRoutingRequired } from "./private-routing-requirement";
import { privateSession, type UnlockedIdentity } from "./private-session";
import { privateBoundRpc } from "./private-scoped-rpc";
import { stagePrivateAccountInventory } from "./private-inventory-staging";
import { stagePrivateAccountTimer } from "./private-timer-staging";
/** Approving an enrolled device publishes its exact pending encrypted inventory
 * before handing over a short checkpoint. No business data or keys are sent in
 * plaintext; conflicts retain their existing refusal and durable outbox. */
export async function capturePrivateDeviceWorkspaceTrust(userId: string): Promise<PrivateDeviceWorkspaceTrust | null> {
  const binding = privateClientScope(userId), host = await privateAccountInventoryStorageHost(userId);
  try {
    const required = await privateRoutingRequired(binding); binding.check();
    const sync = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive);
    try { await sync.read(); } catch (error) { binding.check(); if (!required && error instanceof PrivateAccountInventoryMissingError) return null; throw error; }
    const transport = privateAccountInventoryTransport(userId);
    for (let i = 0; i < 8; i++) {
      const state = await sync.exportRecovery(); binding.check();
      if (!state.pending.length) break;
      await sync.flushOne(transport); binding.check();
    }
    const profile = await sync.read(), state = await sync.exportRecovery(); binding.check();
    if (state.pending.length || state.conflict || !state.confirmed.version || !state.confirmed.checkpoint.root || canonicalJson(profile.inventory.signed) !== canonicalJson(state.local)) throw new Error("Keep or sync pending account inventory before approving this device");
    const timerHost = await privateAccountTimerStorageHost(userId);
    try {
      const timers = await privateAccountTimerStore(userId, timerHost.storage, timerHost.exclusive), timer = await timers.exportRecovery(); binding.check();
      if (timer && (timer.state.pending.length || timer.state.committed.length || timer.state.conflict || timer.state.preparing)) throw new Error("Sync or export pending timer work before approving another device");
      const timerState = timer ? { v: 1 as const, confirmed: timer.state.confirmed, pending: [], committed: [], conflict: null } : null;
      return privateDeviceWorkspaceTrustSchema.parse({ inventory: profile.inventory.checkpoint, transport: state.confirmed.checkpoint, ...(timer ? { timer: { digest: await privateRecordDigest(timerState), ...timer.state.confirmed } } : {}) });
    } finally { timerHost.close(); }
  } finally { host.close(); }
}
/** The confirmation-authenticated device supplies the anchor, never the API.
 * Fetch just that encrypted version and refuse rollback, substitution and any
 * overwrite of a distinct local inventory or pending/conflicting work. */
export async function restorePrivateDeviceWorkspaceTrust(userId: string, input: PrivateDeviceWorkspaceTrust, staged?: { server: string; secrets: UnlockedIdentity; check: () => void }) {
  const trust = privateDeviceWorkspaceTrustSchema.parse(input);
  const binding = staged ? { server: staged.server, userId, check: staged.check, current: () => { try { staged.check(); return true; } catch { return false; } } } : privateClientScope(userId);
  binding.check(); const secrets = staged?.secrets ?? privateSession(userId)!;
  const { rpc, supported } = privateBoundRpc(binding, "privacy.accountInventory"); supported();
  const page = await rpc.privacy.inventoryVersions.mutate({ after: trust.transport.revision - 1, through: trust.transport.revision }); supported();
  if (page.through !== trust.transport.revision || page.next !== null || page.root !== trust.transport.root || page.versions.length !== 1 || page.versions[0]!.header.revision !== trust.transport.revision) throw new Error("Account inventory differs from this device's approved checkpoint");
  const sync = await stagePrivateAccountInventory(binding, secrets, binding.check);
  try {
    binding.check();
    await sync.restore(page.versions[0], trust); binding.check();
  } finally { sync.close(); }
  if ("timer" in trust) {
    const timers = await stagePrivateAccountTimer(binding, secrets, binding.check);
    try {
      const state = { v: 1 as const, confirmed: { checkpoint: trust.timer.checkpoint, signed: trust.timer.signed }, pending: [], committed: [], conflict: null };
      await timers.restore(state, trust.timer.digest); binding.check();
    } finally { timers.close(); }
  }
}
