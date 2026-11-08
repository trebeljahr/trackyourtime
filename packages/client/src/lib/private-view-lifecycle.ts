import { privateSessionVersion, subscribePrivateSession, privateAccountId, privateDataOrigin, subscribePrivateAccount } from "./private-session";
import { privateRoutingRevision, subscribePrivateRoutingRequirement } from "./private-routing-requirement";
export type PrivateViewScope = { server: string; userId: string };
/** "first-view": this page load just showed its first private content, for
 * the scope that was already active — nothing on screen held private data
 * before it, so screens keep their state and only re-read. "change": anything
 * else (lock, new keys, routing, another workspace or account), after which
 * every cached read and form is discarded. */
export type PrivateViewEpochChange = "first-view" | "change";
const views = new Set<(scope: PrivateViewScope) => void>(), listeners = new Set<(change: PrivateViewEpochChange) => void>();
/** Only primitive epochs/public scope survive a lock. No decrypted view, root
 * key or workspace data is retained by this lifecycle channel. */
const seen = new Set<string>();
let workspaceContext: string | null = null;
const scopeKey = ({ server, userId }: PrivateViewScope) => JSON.stringify([server, userId]);
const currentScope = () => { const userId = privateAccountId(); return userId ? { server: privateDataOrigin(), userId } : null; };
/** Standard accounts keep their forms when optional key setup changes a root.
 * Only an account that displayed private content uses a private view epoch. */
export const privateViewEpoch = () => {
  const scope = currentScope();
  return scope && seen.has(scopeKey(scope)) ? JSON.stringify([scope.server, scope.userId, privateSessionVersion(), privateRoutingRevision(), workspaceContext]) : "0";
};
let lastEpoch = "0", mountGeneration = 0;
const changed = (firstView = false) => {
  const next = privateViewEpoch(); if (next === lastEpoch) return;
  const change: PrivateViewEpochChange = firstView && lastEpoch === "0" ? "first-view" : "change";
  if (change === "change") mountGeneration++;
  lastEpoch = next; for (const listener of listeners) listener(change);
};
/** The identity private forms mount under: it moves on every epoch change
 * except a first view, so a dialog opened while the page's first private
 * read was in flight stays open. */
export const privateViewMountKey = () => String(mountGeneration);
subscribePrivateSession(() => changed());
subscribePrivateAccount(() => changed());
subscribePrivateRoutingRequirement(() => changed());
export function notePrivateView(scope: PrivateViewScope) {
  const active = currentScope();
  if (!active || scopeKey(active) !== scopeKey(scope)) throw new Error("Private view account changed before publication");
  for (const listener of views) listener(scope);
  const fresh = !seen.has(scopeKey(scope)); seen.add(scopeKey(scope)); changed(fresh);
}
export function subscribePrivateView(listener: (scope: PrivateViewScope) => void) { views.add(listener); return () => { views.delete(listener); }; }
export function subscribePrivateViewEpoch(listener: (change: PrivateViewEpochChange) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Public selection only. Seen-private accounts remount forms and discard
 * local filters before another workspace can issue requests. */
export function setPrivateViewWorkspaceContext(workspaceId: string | null) { workspaceContext = workspaceId; changed(); }
