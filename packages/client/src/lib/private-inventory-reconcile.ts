/**
 * Joined workspaces in the signed account inventory
 * (docs/private-workspace-protocol.md → "Password unlock").
 *
 * With keys, every content request must name a workspace the account's signed
 * inventory lists (private-content-route.ts), and unknown ids never default
 * to standard. Creating a workspace reserves its id first, but joining one by
 * invitation adds a membership the inventory has never seen. After each
 * workspace list, the listed workspaces it lacks are added as standard,
 * signed with the account key and delivered.
 *
 * Standard is the only honest mode today: the server refuses every private
 * workspace. Once private workspaces exist, joining one needs its own
 * verified initialization, and this must stop treating an unknown id as
 * standard.
 */
import { openPrivateAccountInventorySync } from "./private-inventory-sync";
import { privateSession } from "./private-session";

let running: Promise<void> | null = null;

export function reconcileJoinedWorkspaces(userId: string, listed: readonly { id: string }[]): Promise<void> {
  if (!privateSession(userId) || !listed.length) return Promise.resolve();
  const previous = running ?? Promise.resolve();
  const next = previous.then(async () => {
    const sync = await openPrivateAccountInventorySync(userId);
    try {
      const { inventory } = await sync.read();
      const rows = inventory.signed.inventory.workspaces;
      const known = new Set(rows.map((row) => row.workspaceId));
      const added = listed.map((workspace) => workspace.id).filter((id) => !known.has(id));
      if (added.length) await sync.update([...rows, ...added.map((workspaceId) => ({ workspaceId, mode: "standard" as const }))]);
      for (let i = 0; i < 8 && (await sync.flushOne()).pending > 0; i++) { /* one version per pass */ }
    } finally { sync.close(); }
  }).catch((error) => { console.warn("[private] could not add joined workspaces to the account inventory", error); });
  running = next;
  return next;
}
