import { privateSessionVersion, subscribePrivateSession } from "./private-session";
import { privateRoutingRevision, subscribePrivateRoutingRequirement } from "./private-routing-requirement";
export type PrivateViewScope = { server: string; userId: string };
const views = new Set<(scope: PrivateViewScope) => void>(), listeners = new Set<() => void>();
let seen = false;
const changed = () => { if (seen) for (const listener of listeners) listener(); };
subscribePrivateSession(changed);
subscribePrivateRoutingRequirement(changed);
export function notePrivateView(scope: PrivateViewScope) {
  for (const listener of views) listener(scope);
  if (!seen) { seen = true; changed(); }
}
export function subscribePrivateView(listener: (scope: PrivateViewScope) => void) { views.add(listener); return () => { views.delete(listener); }; }
export function subscribePrivateViewEpoch(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Only primitive epochs/public scope survive a lock. No decrypted view, root
 * key or workspace data is retained by this lifecycle channel. */
export const privateViewEpoch = () => seen ? `${privateSessionVersion()}:${privateRoutingRevision()}` : "0";
