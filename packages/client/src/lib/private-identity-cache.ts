import { privateCachedIdentitySchema as savedSchema, privateIdentitySchema, type PrivateIdentity } from "@starter/shared";
import { canonicalJson, decodeSecret, signPrivateChange, verifyPrivateRecoveryIdentity, type KeyValueStorage } from "@starter/core";
import { checkedPrivateSession, privateDataOrigin, privateOperationScope, privateSession } from "./private-session";
import { isCapacitor } from "./shell";
import { preferencesStorage } from "@/mobile/preferences-storage";
const PREFIX = "trackyourtime.private-identity:";
const MAX_CHARS = 500_000;
type Scope = { server: string; userId: string };
const coordinates = ({ kty, crv, x, y }: PrivateIdentity["publicKey"]) => ({ kty, crv, x, y });
export const samePrivateIdentityKeys = (left: PrivateIdentity, right: PrivateIdentity) => canonicalJson([coordinates(left.publicKey), coordinates(left.signingPublicKey)]) === canonicalJson([coordinates(right.publicKey), coordinates(right.signingPublicKey)]);
function keyOf(input: Scope) {
  const scope = input, origin = new URL(scope.server);
  if (typeof scope.userId !== "string" || !scope.userId || scope.userId.length > 100 || scope.server.length > 2048 || origin.origin !== scope.server || !["http:", "https:"].includes(origin.protocol)) throw new Error("Invalid saved key scope");
  return `${PREFIX}${encodeURIComponent(JSON.stringify([scope.server, scope.userId]))}`;
}
function storage(): KeyValueStorage {
  if (isCapacitor()) return preferencesStorage({ strict: true });
  if (typeof window === "undefined") throw new Error("Saved keys require persistent device storage");
  return { getItem: async (key) => window.localStorage.getItem(key), setItem: async (key, raw) => { window.localStorage.setItem(key, raw); }, removeItem: async (key) => { window.localStorage.removeItem(key); } };
}
async function locked<T>(scope: Scope, work: (backing: KeyValueStorage, key: string) => Promise<T>) {
  const key = keyOf(scope);
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Saved keys require Web Locks");
  return navigator.locks.request(`${key}:lock`, () => work(storage(), key));
}
async function decode(raw: string | null, scope: Scope): Promise<PrivateIdentity | null> {
  if (raw === null) return null;
  try {
    if (raw.length > MAX_CHARS) throw new Error();
    const { statement, signature } = savedSchema.parse(JSON.parse(raw));
    if (statement.server !== scope.server || statement.userId !== scope.userId) throw new Error();
    const key = await crypto.subtle.importKey("jwk", statement.identity.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signature, 64), new TextEncoder().encode(canonicalJson(statement)))) throw new Error();
    return statement.identity;
  } catch { throw new Error("This device's saved encryption keys could not be verified. Existing keys were kept."); }
}
/** Ciphertext envelopes and public keys only. This local signature detects
 * corruption/substitution without fetching server keys. It is not a remote
 * freshness proof, device enrollment, authorization, or protection against
 * replacement of all device storage by malicious code on this origin. */
export async function cachedPrivateIdentity(userId: string): Promise<PrivateIdentity | null> {
  const scope = { server: privateDataOrigin(), userId }, check = privateOperationScope(userId);
  return locked(scope, async (backing, key) => { check(); const identity = await decode(await backing.getItem(key), scope); check(); return identity; });
}
/** Call only after successful local decryption/setup. Never cache an arbitrary
 * API response or substitute account roots. A previously saved recovery box
 * survives passkey-only unlock; changing it requires explicit recovery-key
 * verification, independently of the passkey result. No raw key is persisted. */
export async function rememberPrivateIdentity(userId: string, input: PrivateIdentity, recoveryKey?: string): Promise<PrivateIdentity> {
  const identity = privateIdentitySchema.parse(input), scope = { server: privateDataOrigin(), userId }, captured = privateOperationScope(userId);
  const root = checkedPrivateSession(userId, identity);
  const check = () => { captured(); if (privateSession(userId) !== root) throw new Error("Private data changed before saved keys were confirmed"); };
  return locked(scope, async (backing, key) => {
    check(); const previous = await decode(await backing.getItem(key), scope); check();
    if (previous && !samePrivateIdentityKeys(previous, identity)) throw new Error("The account's encryption keys differ from this device's saved keys. Existing keys were kept.");
    if (recoveryKey !== undefined) { await verifyPrivateRecoveryIdentity(identity, recoveryKey, root, scope, () => { try { check(); return true; } catch { return false; } }); check(); }
    else if (previous) identity.recovery = previous.recovery;
    const statement = { protocol: "trackyourtime-device-identity-v1" as const, ...scope, identity };
    const signed = savedSchema.parse({ statement, signature: await signPrivateChange(root.signingPrivateKey, statement) }); check();
    const raw = JSON.stringify(signed); if (raw.length > MAX_CHARS) throw new Error("Saved keys exceed device storage limits");
    await backing.setItem(key, raw); check();
    const reopened = await decode(await backing.getItem(key), scope); check();
    if (canonicalJson(reopened) !== canonicalJson(identity)) throw new Error("Saved encryption keys could not be reopened");
    return reopened!;
  });
}
/** Successful account deletion only. Sign-out/locking retain encrypted work
 * and its wrappers. This operation does not remove the private-routing fence. */
export async function eraseCachedPrivateIdentity(scope: Scope): Promise<void> {
  await locked(scope, async (backing, key) => { await backing.removeItem(key); if (await backing.getItem(key) !== null) throw new Error("Could not erase saved encryption keys"); });
}
