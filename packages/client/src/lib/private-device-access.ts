import type { KeyValueStorage } from "@starter/core";
import { isCapacitor } from "./shell";
import { preferencesStorage } from "@/mobile/preferences-storage";
import { privateRoutingRequired } from "./private-routing-requirement";
import { PrivateContentUnavailableError } from "./private-content-error";
const PREFIX = "trackyourtime.standard-device-access:", VALUE = "trackyourtime-standard-device-access-v1";
type Scope = { server: string; userId: string };
const keyOf = ({ server, userId }: Scope) => {
  const origin = new URL(server);
  if (origin.origin !== server || !["https:", "http:"].includes(origin.protocol) || !userId || userId.length > 100) throw new Error("Invalid device access scope");
  return `${PREFIX}${encodeURIComponent(JSON.stringify([server, userId]))}`;
};
function storage(): KeyValueStorage {
  if (isCapacitor()) return preferencesStorage({ strict: true });
  if (typeof window === "undefined") throw new Error("Device enrollment requires persistent local storage");
  return { getItem: async (key) => localStorage.getItem(key), setItem: async (key, value) => { localStorage.setItem(key, value); }, removeItem: async (key) => { localStorage.removeItem(key); } };
}
const listeners = new Set<() => void>(); let revision = 0;
const changed = () => { revision++; for (const listener of listeners) listener(); };
export const privateDeviceAccessRevision = () => revision;
export const subscribePrivateDeviceAccess = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
if (typeof window !== "undefined") window.addEventListener("storage", (event) => { if (event.key === null || event.key.startsWith(PREFIX)) changed(); });
/** Public per-device user choice only. API mode claims, password login and an
 * old workspace cache cannot prove that an account has no encrypted history.
 * Private routing protection always takes precedence; there is no downgrade. */
export async function standardDeviceAccess(scope: Scope): Promise<boolean> {
  const raw = await storage().getItem(keyOf(scope));
  if (raw !== null && raw !== VALUE) throw new Error("This device's storage choice could not be verified");
  return raw === VALUE;
}
export async function requireStandardDeviceAccess(scope: Scope) {
  if (await privateRoutingRequired(scope)) throw new PrivateContentUnavailableError();
  if (!await standardDeviceAccess(scope)) throw new PrivateContentUnavailableError("Connect this device or confirm standard storage before accessing workspace data");
  if (await privateRoutingRequired(scope)) throw new PrivateContentUnavailableError();
}
/** Call only for an explicit local user choice. It cannot open or alter a
 * protected workspace, enroll keys, or delete the private-routing guard. */
export async function confirmStandardDeviceAccess(scope: Scope, current: () => boolean) {
  const check = () => { if (!current()) throw new Error("The account changed before device enrollment finished"); };
  check(); const key = keyOf(scope), backing = storage();
  if (await privateRoutingRequired(scope)) throw new Error("Unlock this account's private keys and trusted inventory instead of choosing standard storage"); check();
  const existing = await backing.getItem(key); check();
  if (existing !== null && existing !== VALUE) throw new Error("This device's storage choice could not be verified");
  await backing.setItem(key, VALUE); check();
  if (await backing.getItem(key) !== VALUE) throw new Error("Could not confirm this device's storage choice"); check();
  if (await privateRoutingRequired(scope)) throw new Error("Private workspace protection changed during device enrollment"); check(); changed();
}
