import { assertPrivateAccountInventory, type VerifiedPrivateAccountInventory } from "@starter/core";
type Scope = { server: string; userId: string };
let cached: { scope: Scope; digest: string; modes: ReadonlyMap<string, "standard" | "encrypted">; current: () => boolean } | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
/** A transient hint for local query and mutation scheduling, never routing authority.
 * Only a branded verified inventory can populate it. No business data or keys
 * are retained; final routing and replica checks remain mandatory. */
export function rememberVerifiedWorkspaceModes(inventory: VerifiedPrivateAccountInventory, scope: Scope, current: () => boolean) {
  assertPrivateAccountInventory(inventory, scope); if (!current()) throw new Error("Workspace mode observation changed");
  if (cached?.scope.server === scope.server && cached.scope.userId === scope.userId && cached.digest === inventory.checkpoint.digest && cached.current()) return;
  cached = { scope: { ...scope }, digest: inventory.checkpoint.digest, modes: new Map(inventory.signed.inventory.workspaces.map((row) => [row.workspaceId, row.mode])), current }; changed();
}
export function forgetVerifiedWorkspaceModes() { if (cached) { cached = null; changed(); } }
export function observedWorkspaceMode(workspaceId: string | null): "standard" | "encrypted" | null {
  if (!workspaceId || !cached?.current()) return null;
  return cached.modes.get(workspaceId) ?? null;
}
export function subscribeVerifiedWorkspaceModes(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function hasVerifiedWorkspaceModes(): boolean { return cached?.current() === true; }
