import { eraseStoredWorkspaceNames, noteWorkspaceNameProtection } from "./workspace-name-privacy";
import type { KeyValueStorage } from "@starter/core";
import { isCapacitor } from "./shell";
import { preferencesStorage } from "@/mobile/preferences-storage";
const PREFIX = "trackyourtime.private-routing-required:";
const VALUE = "trackyourtime-private-routing-required-v1";
const listeners = new Set<() => void>();
let revision = 0;
const digests = new Map<string, string>();
export const privateRoutingRevision = () => revision;
const changed = () => { revision++; for (const listener of listeners) listener(); };
if (typeof window !== "undefined") window.addEventListener("storage", (event) => { if (event.key === null || event.key.startsWith(PREFIX)) changed(); });
export const subscribePrivateRoutingRequirement = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function storage(): KeyValueStorage {
  if (isCapacitor()) return preferencesStorage({ strict: true });
  if (typeof window === "undefined") throw new Error("Private routing metadata requires persistent device storage");
  // Never use the cache adapter: it deliberately swallows storage failures.
  return { getItem: async (key) => window.localStorage.getItem(key), setItem: async (key, value) => { window.localStorage.setItem(key, value); }, removeItem: async (key) => { window.localStorage.removeItem(key); } };
}
const keyOf = (scope: { server: string; userId: string }) => {
  const { server, userId } = scope;
  if (new URL(server).origin !== server || !["https:", "http:"].includes(new URL(server).protocol) || !userId || userId.length > 100) throw new Error("Invalid private routing scope");
  return `${PREFIX}${encodeURIComponent(JSON.stringify([server, userId]))}`;
};
/** Public scope metadata only, never keys or business data. Presence requires
 * the signed encrypted inventory to choose an adapter after every restart.
 * It is not proof of current policy, and there is no downgrade/remove API.
 * Clearing all device storage or using a new device needs trusted enrollment. */
/** Synchronous hydration may only use this on web. It requires unlock, never
 * authorizes routing or proves that a private inventory is current. */
export function privateRoutingRequiredOnWeb(scope: { server: string; userId: string }): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(keyOf(scope));
  if (raw !== null && raw !== VALUE) throw new Error("Private routing metadata could not be verified");
  return raw === VALUE;
}
export async function privateRoutingRequired(scope: { server: string; userId: string }): Promise<boolean> {
  const raw = await storage().getItem(keyOf(scope));
  if (raw !== null && raw !== VALUE) throw new Error("Private routing metadata could not be verified; existing data was kept");
  return raw === VALUE;
}
export async function requirePrivateRouting(scope: { server: string; userId: string }, current: () => boolean, publishing = false, digest?: string): Promise<void> {
  const key = keyOf(scope), backing = storage(), check = () => { if (!current()) throw new Error("Private data changed before routing protection was saved"); };
  check(); const raw = await backing.getItem(key); check();
  if (raw !== null && raw !== VALUE) throw new Error("Private routing metadata could not be verified; existing data was kept");
  const policyChanged = digest !== undefined && digests.get(key) !== digest;
  if (raw === VALUE) { await eraseStoredWorkspaceNames(scope, current); check(); noteWorkspaceNameProtection(scope); if (digest) digests.set(key, digest); if (policyChanged || (publishing && !digest)) changed(); return; }
  await backing.setItem(key, VALUE); check();
  if (await backing.getItem(key) !== VALUE) throw new Error("Could not confirm private routing protection; existing data was kept"); check();
  await eraseStoredWorkspaceNames(scope, current); check(); noteWorkspaceNameProtection(scope);
  if (digest) digests.set(key, digest); changed();
}
