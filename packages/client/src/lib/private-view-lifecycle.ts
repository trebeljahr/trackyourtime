import { privateSessionVersion, subscribePrivateSession, privateAccountId, privateDataOrigin, subscribePrivateAccount } from "./private-session";
import { privateRoutingRevision, subscribePrivateRoutingRequirement } from "./private-routing-requirement";
export type PrivateViewScope = { server: string; userId: string };
const views = new Set<(scope: PrivateViewScope) => void>(), listeners = new Set<() => void>();
/** Only primitive epochs/public scope survive a lock. No decrypted view, root
 * key or workspace data is retained by this lifecycle channel. */
const seen = new Set<string>();
const scopeKey = ({ server, userId }: PrivateViewScope) => JSON.stringify([server, userId]);
const currentScope = () => { const userId = privateAccountId(); return userId ? { server: privateDataOrigin(), userId } : null; };
/** Standard accounts keep their forms when optional key setup changes a root.
 * Only an account that displayed private content uses a private view epoch. */
export const privateViewEpoch = () => {
  const scope = currentScope();
  return scope && seen.has(scopeKey(scope)) ? JSON.stringify([scope.server, scope.userId, privateSessionVersion(), privateRoutingRevision()]) : "0";
};
let lastEpoch = "0";
const changed = () => { const next = privateViewEpoch(); if (next === lastEpoch) return; lastEpoch = next; for (const listener of listeners) listener(); };
subscribePrivateSession(changed);
subscribePrivateAccount(changed);
subscribePrivateRoutingRequirement(changed);
export function notePrivateView(scope: PrivateViewScope) {
  const active = currentScope();
  if (!active || scopeKey(active) !== scopeKey(scope)) throw new Error("Private view account changed before publication");
  for (const listener of views) listener(scope);
  seen.add(scopeKey(scope)); changed();
}
export function subscribePrivateView(listener: (scope: PrivateViewScope) => void) { views.add(listener); return () => { views.delete(listener); }; }
export function subscribePrivateViewEpoch(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
