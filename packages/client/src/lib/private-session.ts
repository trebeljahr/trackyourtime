import { createKeyPair, createPrivateStorage, createSigningPair, decodeSecret, deriveSecret, encodeSecret, randomSecret, seal, unseal, type Ciphertext, type KeyValueStorage, type PublicKey } from "@starter/core";
import { desktopActivity } from "./desktop-activity";
import type { PrivateIdentity } from "@starter/shared";
import { getApiOrigin, subscribeApiOrigin } from "./api-origin";
import { requirePrivateRouting } from "./private-routing-requirement";
import { forgetUnlockedKeys, hasSavedUnlock, rememberUnlockedKeys, restoreUnlockedKeys } from "./private-device-key";
export const PRIVATE_PRF_INPUT = new TextEncoder().encode("trackyourtime-private-data-v1");
export type UnlockedIdentity = { v: 1; master: string; privateKey: PublicKey; signingPrivateKey: PublicKey };
let session: { userId: string; origin: string; secrets: UnlockedIdentity } | null = null;
let generation = 0;
let resolvedAccount: string | null | undefined;
const listeners = new Set<() => void>();
const accountListeners = new Set<() => void>();
export const subscribePrivateAccount = (listener: () => void) => { accountListeners.add(listener); return () => { accountListeners.delete(listener); }; };
export const privateAccountId = (): string | null | undefined => resolvedAccount;
export function whenPrivateAccountReady(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Account lookup canceled"));
  if (resolvedAccount !== undefined) return Promise.resolve(resolvedAccount);
  return new Promise((resolve, reject) => {
    const cleanup = () => { accountListeners.delete(read); signal?.removeEventListener("abort", abort); };
    const read = () => { if (resolvedAccount !== undefined) { cleanup(); resolve(resolvedAccount); } };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Account lookup canceled")); };
    accountListeners.add(read); signal?.addEventListener("abort", abort, { once: true }); read();
  });
}
let version = 0;
export const privateSessionVersion = (): number => version;
const changed = () => { version++; for (const listener of listeners) listener(); };
export function lockPrivateData(): void { generation++; session = null; void desktopActivity()?.lock?.().catch(() => undefined); changed(); }
/** Sign-out, account deletion and Settings → Lock: also erase this device's
 * saved unlock (lib/private-device-key.ts), so a reload asks again. */
export function lockAndForgetPrivateData(): void {
  const userId = session?.userId ?? resolvedAccount ?? null, origin = privateDataOrigin();
  lockPrivateData();
  if (userId) void forgetUnlockedKeys(origin, userId);
}
let restoring = 0, restoreInFlight: Promise<unknown> | null = null;
/** Settles once a running restore of this device's saved unlock has finished;
 * at once when none is running. Never waits for a sign-in. */
export const whenUnlockRestoreSettled = (): Promise<void> => (restoreInFlight ? restoreInFlight.then(() => undefined, () => undefined) : Promise.resolve());
// api-origin publishes on readiness too (on web, once, with nothing changed).
// Only a different server invalidates the account: resetting it on a no-op
// publish after AuthProvider resolved it left every private-scoped request
// waiting for an account that was never announced again (a stuck tracker
// after reload), and dropped a restored unlock (lib/private-device-key.ts).
let accountOrigin: string | undefined;
subscribeApiOrigin(() => {
  if (accountOrigin !== undefined && privateDataOrigin() === accountOrigin) return;
  accountOrigin = undefined;
  resolvedAccount = undefined; lockPrivateData(); for (const listener of accountListeners) listener();
});
export function privateSession(userId: string): UnlockedIdentity | null {
  return session?.userId === userId && session.origin === getApiOrigin() ? session.secrets : null;
}
export function subscribePrivateSession(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const privateDataOrigin = (): string => getApiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
const context = (userId: string) => `trackyourtime:identity:v1:${privateDataOrigin()}:${userId}`;
/** A late biometric prompt, decrypt, or enrollment reply cannot undo a lock,
 * sign-out, account switch, or server switch. Capture before the first await. */
export function privateOperationScope(userId: string): () => void {
  const at = generation, origin = privateDataOrigin();
  return () => {
    if (at !== generation || origin !== privateDataOrigin() || (resolvedAccount != null && resolvedAccount !== userId)) throw new Error("Private data changed during this operation");
  };
}
/** Imported keys cannot prove absence of private workspaces on a cleared/new
 * device. Persist refusal of plaintext fallback before publishing those keys. */
function privateImportScope(userId: string) {
  const captured = privateOperationScope(userId), at = privateSessionVersion();
  return () => { captured(); if (privateSessionVersion() !== at) throw new Error("Private keys changed during this unlock"); };
}
async function protectImportedRoot(userId: string, check: () => void) {
  const scope = { server: privateDataOrigin(), userId };
  await requirePrivateRouting(scope, () => { try { check(); return true; } catch { return false; } }); check();
}
export async function newPrivateIdentity(userId: string): Promise<{ identity: PrivateIdentity; secrets: UnlockedIdentity; recoveryKey: string; assertCurrent: () => void }> {
  const assertCurrent = privateOperationScope(userId), aad = context(userId);
  const pair = await createKeyPair(), signing = await createSigningPair(), recovery = randomSecret();
  const secrets: UnlockedIdentity = { v: 1, master: encodeSecret(randomSecret()), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey };
  try {
    const identity = { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(recovery, secrets, aad), passkeys: [] };
    assertCurrent();
    return { identity, secrets, recoveryKey: encodeSecret(recovery), assertCurrent };
  } finally { recovery.fill(0); }
}
export function installPrivateSession(userId: string, secrets: UnlockedIdentity): void {
  if (secrets.v !== 1 || decodeSecret(secrets.master, 32).length !== 32 || !secrets.privateKey.d || !secrets.signingPrivateKey.d) throw new Error("Invalid private identity");
  session = { userId, origin: getApiOrigin(), secrets }; changed();
  void rememberUnlockedKeys(privateDataOrigin(), userId, secrets);
  void resumePrivateActivity(userId).catch(() => undefined);
}
export function assertIdentityKeys(identity: Pick<PrivateIdentity, "publicKey" | "signingPublicKey">, secrets: UnlockedIdentity): void {
  const same = (publicKey: PublicKey, privateKey: PublicKey) => publicKey.kty === privateKey.kty && publicKey.crv === privateKey.crv && publicKey.x === privateKey.x && publicKey.y === privateKey.y;
  if (!same(identity.publicKey, secrets.privateKey) || !same(identity.signingPublicKey, secrets.signingPrivateKey)) throw new Error("Private identity public keys do not match its encrypted keys");
}
export function checkedPrivateSession(userId: string, identity: Pick<PrivateIdentity, "publicKey" | "signingPublicKey">): UnlockedIdentity {
  const current = privateSession(userId); if (!current) throw new Error("Unlock private data first");
  assertIdentityKeys(identity, current); return current;
}
export function installVerifiedPrivateSession(userId: string, identity: Pick<PrivateIdentity, "publicKey" | "signingPublicKey">, secrets: UnlockedIdentity): void {
  assertIdentityKeys(identity, secrets); installPrivateSession(userId, secrets);
}
export async function unlockPrivateRecovery(userId: string, identity: PrivateIdentity, recoveryKey: string): Promise<void> {
  const assertCurrent = privateImportScope(userId), aad = context(userId);
  const raw = decodeSecret(recoveryKey.trim(), 32);
  try {
    const secrets = await unseal<UnlockedIdentity>(raw, identity.recovery, aad);
    assertIdentityKeys(identity, secrets); assertCurrent(); await protectImportedRoot(userId, assertCurrent); installPrivateSession(userId, secrets);
  }
  finally { raw.fill(0); }
}
/** A new recovery key for unlocked keys: the envelope to store and the key to show once. */
export async function newRecoveryEnvelope(userId: string, secrets: UnlockedIdentity): Promise<{ recovery: Ciphertext; recoveryKey: string }> {
  const recovery = randomSecret();
  try { return { recovery: await seal(recovery, secrets, context(userId)), recoveryKey: encodeSecret(recovery) }; }
  finally { recovery.fill(0); }
}
/** Password unlock: the identity sealed with the device-derived wrapping key. */
export async function sealIdentityForPassword(userId: string, wrappingKey: Uint8Array, secrets: UnlockedIdentity): Promise<Ciphertext> {
  return seal(wrappingKey, secrets, context(userId));
}
/** Open the account keys with the wrapping key derived from the typed password.
 * Like a recovery-key unlock, this device then refuses plaintext fallback. */
export async function unlockPrivatePassword(userId: string, identity: PrivateIdentity, wrappingKey: Uint8Array): Promise<void> {
  if (!identity.password) throw new Error("This account's keys are not protected by its password yet");
  const assertCurrent = privateImportScope(userId);
  const secrets = await unseal<UnlockedIdentity>(wrappingKey, identity.password.envelope, context(userId));
  assertIdentityKeys(identity, secrets); assertCurrent(); await protectImportedRoot(userId, assertCurrent); installPrivateSession(userId, secrets);
}
export function prfBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  try {
    if (typeof value === "string") { const decoded = decodeSecret(value, 32); return decoded.length === 32 ? decoded : null; }
    if (value instanceof ArrayBuffer && value.byteLength === 32) return new Uint8Array(value);
    if (ArrayBuffer.isView(value) && value.byteLength === 32) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  } catch { /* Unsupported output is not encryption support. */ }
  return null;
}
export async function wrapIdentityWithPrf(userId: string, secret: Uint8Array, identity: PrivateIdentity): Promise<Ciphertext> {
  const current = privateSession(userId); if (!current) throw new Error("Unlock private data first");
  assertIdentityKeys(identity, current);
  const assertCurrent = privateOperationScope(userId), aad = context(userId);
  const key = await deriveSecret(secret, aad);
  try {
    assertCurrent(); if (privateSession(userId) !== current) throw new Error("Private data is locked");
    const box = await seal(key, current, aad);
    assertCurrent(); if (privateSession(userId) !== current) throw new Error("Private data is locked");
    return box;
  } finally { key.fill(0); }
}
export async function unlockPrivatePrf(userId: string, identity: PrivateIdentity, credentialId: string, secret: Uint8Array): Promise<void> {
  const assertCurrent = privateImportScope(userId), aad = context(userId);
  const saved = identity.passkeys.find((p) => p.credentialId === credentialId);
  if (!saved) throw new Error("This passkey is not enrolled for encryption");
  const key = await deriveSecret(secret, aad);
  try {
    const secrets = await unseal<UnlockedIdentity>(key, saved.envelope, aad);
    assertIdentityKeys(identity, secrets); assertCurrent(); await protectImportedRoot(userId, assertCurrent); installPrivateSession(userId, secrets);
  } finally { key.fill(0); }
}
/** Evaluate credential-bound PRF output locally. It is never an API payload. */
export async function evaluatePrivatePasskey(credentialIds: string[]): Promise<{ credentialId: string; secret: Uint8Array<ArrayBuffer> }> {
  if (!credentialIds.length) throw new Error("No passkey is available for encryption");
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: randomSecret(), rpId: window.location.hostname, userVerification: "required",
    allowCredentials: credentialIds.map((id) => ({ id: decodeSecret(id, 1500), type: "public-key" as const })),
    extensions: { prf: { eval: { first: PRIVATE_PRF_INPUT } } },
  } }) as PublicKeyCredential | null;
  const secret = prfBytes(credential?.getClientExtensionResults().prf?.results?.first);
  if (!credential || !secret) throw new Error("Passkey encryption is not supported here");
  return { credentialId: credential.id, secret };
}
export async function unlockWithSavedPasskey(userId: string, identity: PrivateIdentity): Promise<void> {
  const assertCurrent = privateImportScope(userId);
  const { credentialId, secret } = await evaluatePrivatePasskey(identity.passkeys.map((p) => p.credentialId));
  try { assertCurrent(); await unlockPrivatePrf(userId, identity, credentialId, secret); } finally { secret.fill(0); }
}

/** The renderer sends only a purpose-specific key, never its master/private keys. */
export async function protectPrivateActivity(userId: string, remember?: boolean): Promise<void> {
  const current = privateSession(userId), activity = desktopActivity();
  if (!current || !activity?.protect) throw new Error("Unlock private data first");
  const master = decodeSecret(current.master, 32);
  const key = await deriveSecret(master, `trackyourtime-local-activity-v1:${privateDataOrigin()}:${userId}`); master.fill(0);
  try {
    // A sign-out or server switch during derivation must not reinstall a key.
    if (privateSession(userId) !== current) throw new Error("Private data is locked");
    await activity.protect({ key: encodeSecret(key), userId, origin: privateDataOrigin(), ...(remember === undefined ? {} : { remember }) });
  } finally { key.fill(0); }
}
export async function resumePrivateActivity(userId: string): Promise<void> {
  const activity = desktopActivity();
  if (!activity?.protect || !privateSession(userId)) return;
  if ((await activity.snapshot()).protection?.encrypted) await protectPrivateActivity(userId);
}
export function privateAccountChanged(userId: string | null): void {
  if ((resolvedAccount != null && resolvedAccount !== userId) || (session && session.userId !== userId)) lockPrivateData();
  const publish = () => { resolvedAccount = userId; accountOrigin = privateDataOrigin(); for (const listener of accountListeners) listener(); };
  if (!userId || session?.userId === userId || resolvedAccount === userId || !hasSavedUnlock(privateDataOrigin(), userId)) { publish(); return; }
  // A device that stayed unlocked reopens its keys before the account counts
  // as resolved, so the device-access boundary never flashes the unlock form.
  // Only a later account change supersedes this restore. Sign-out and Lock
  // erase the saved unlock (and its marker), so a restore that finishes after
  // them installs nothing; a lock from the API origin settling does not.
  const at = ++restoring, origin = privateDataOrigin();
  restoreInFlight = restoreUnlockedKeys<UnlockedIdentity>(origin, userId)
    .then((secrets) => { if (at === restoring && secrets && !session && origin === privateDataOrigin() && hasSavedUnlock(origin, userId)) { try { installPrivateSession(userId, secrets); } catch { void forgetUnlockedKeys(origin, userId); } } })
    .catch(() => undefined)
    .finally(() => { if (at === restoring) { restoreInFlight = null; publish(); } });
}

/** Private workspace replicas use their own scoped namespace. The legacy
 * multi-account queue must be migrated separately, under its existing lock. */
export function privateWorkspaceStorage(userId: string, workspaceId: string, storage: KeyValueStorage) {
  const server = privateDataOrigin();
  return createPrivateStorage({ storage, scope: { server, userId, workspaceId }, resolveKey: () => {
    const current = privateSession(userId);
    if (!current || privateDataOrigin() !== server) return null;
    const assertCurrent = privateOperationScope(userId), key = decodeSecret(current.master, 32);
    return { key, current: () => {
      try { assertCurrent(); return privateSession(userId) === current; } catch { return false; }
    }, release: () => key.fill(0) };
  } });
}
