/**
 * Password unlock (docs/private-workspace-protocol.md → "Password unlock").
 *
 * The typed password never reaches the server. Before sign-in the client asks
 * for the account's KDF parameters, derives a login secret (sent as the
 * "password") and a wrapping key (kept in memory), and after sign-in uses the
 * wrapping key to open or create the account's keys. Existing accounts that
 * still have a typed password ("legacy") sign in with it once and upgrade.
 *
 * A server without `auth.passwordUnlock` (an older self-host) keeps the old
 * behaviour: the typed password, no keys.
 */
import { derivePasswordKeys, newPasswordKdf, signPrivateChange } from "@starter/core";
import type { PasswordKdfParams } from "@starter/shared";
import { versionHeaders } from "@starter/core";
import { currentServerApiLevel, refreshServerLevel, serverSupportsNow } from "./server-level";
import { getAbsoluteApiOrigin, getApiOrigin, whenApiOriginReady } from "./api-origin";
import { APP_VERSION } from "./app-version";

type KdfAnswer = { state: "ready" | "legacy" | "pending"; kdf: PasswordKdfParams };
type Pending = {
  email: string;
  origin: string;
  until: number;
  wrappingKey: Uint8Array;
  kdf: PasswordKdfParams;
  /** Legacy/pending accounts: switch the stored password once a session exists. */
  upgrade: { current: string; loginSecret: string; kdf: PasswordKdfParams } | null;
};

const PENDING_MS = 10 * 60_000;
let pending: Pending | null = null;

function forget(): void {
  pending?.wrappingKey.fill(0);
  pending = null;
}

async function rpc() {
  const { getTRPCClient } = await import("./trpc");
  return getTRPCClient();
}

/** Whether this server has password unlock, learning its level first when unknown. */
async function supportsPasswordUnlock(): Promise<boolean> {
  if (currentServerApiLevel() === null) await refreshServerLevel();
  return currentServerApiLevel() !== null && serverSupportsNow("auth.passwordUnlock");
}

/**
 * A pre-sign-in tRPC query as a plain request: the app's tRPC client routes
 * through the private-content link, which refuses before an account is known.
 */
async function publicQuery<T>(path: string, input: unknown): Promise<T> {
  await whenApiOriginReady();
  const response = await fetch(`${getAbsoluteApiOrigin()}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    method: "GET", credentials: "omit", headers: { ...versionHeaders(APP_VERSION) },
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

async function kdfFor(email: string): Promise<KdfAnswer | null> {
  if (!(await supportsPasswordUnlock())) return null;
  return publicQuery<KdfAnswer>("accountPassword.kdf", { email });
}

/** The server's own bounds on a password (better-auth defaults). Outside them
 * the typed value is sent as is, so the server refuses it with its usual
 * message; a derived secret would always fit and hide a too-short password. */
const MIN_PASSWORD = 8, MAX_PASSWORD = 128;
export const outsidePasswordBounds = (password: string): boolean => password.length < MIN_PASSWORD || password.length > MAX_PASSWORD;

/** The new password for a reset link: derived when the account uses password unlock. */
export async function resetPasswordSecret(token: string, password: string): Promise<string> {
  if (outsidePasswordBounds(password) || !(await supportsPasswordUnlock())) return password;
  const kdf = await publicQuery<PasswordKdfParams | null>("accountPassword.kdfForReset", { token });
  if (!kdf) return password;
  const keys = await derivePasswordKeys(password, kdf);
  keys.wrappingKey.fill(0);
  return keys.loginSecret;
}

export type PasswordSignInAttempt = (secret: string) => Promise<{ ok: boolean }>;

/**
 * Sign in with `attempt` (one better-auth password sign-in per call), sending
 * the derived login secret, or the typed password where the account still
 * needs it. Keeps what the key step needs until `finishPasswordUnlock`.
 */
export async function signInWithPasswordUnlock<R extends { ok: boolean }>(email: string, password: string, attempt: (secret: string) => Promise<R>): Promise<R> {
  forget();
  const answer = await kdfFor(email);
  if (!answer) return attempt(password);
  const origin = getApiOrigin();
  const keep = (wrappingKey: Uint8Array, kdf: PasswordKdfParams, upgrade: Pending["upgrade"]) => {
    pending = { email, origin, until: Date.now() + PENDING_MS, wrappingKey, kdf, upgrade };
  };
  if (answer.state === "ready") {
    const keys = await derivePasswordKeys(password, answer.kdf);
    const result = await attempt(keys.loginSecret);
    if (result.ok) keep(keys.wrappingKey, answer.kdf, null); else keys.wrappingKey.fill(0);
    return result;
  }
  const kdf = answer.state === "pending" ? answer.kdf : newPasswordKdf();
  const keys = await derivePasswordKeys(password, kdf);
  let current = password, result = await attempt(password);
  // A cut-off upgrade may already have stored the login secret.
  if (!result.ok && answer.state === "pending") { current = keys.loginSecret; result = await attempt(keys.loginSecret); }
  if (result.ok) keep(keys.wrappingKey, kdf, { current, loginSecret: keys.loginSecret, kdf }); else keys.wrappingKey.fill(0);
  return result;
}

/**
 * What a signed-in account's password must be sent as: two-factor toggles,
 * account deletion, the current password of a change. The derived login
 * secret once the account uses password unlock; the typed password otherwise.
 */
export async function passwordSecretFor(email: string, password: string): Promise<string> {
  const answer = await kdfFor(email);
  if (!answer || answer.state !== "ready") return password;
  const keys = await derivePasswordKeys(password, answer.kdf);
  keys.wrappingKey.fill(0);
  return keys.loginSecret;
}

/** {@link passwordSecretFor} for the signed-in account's own email. */
export async function passwordSecretForSignedIn(password: string): Promise<string> {
  const { authClient } = await import("./auth-client");
  const email = authClient.$store.atoms.session.get().data?.user.email ?? (await authClient.getSession()).data?.user.email;
  return email ? passwordSecretFor(email, password) : password;
}

/** The new password of a change or reset, under the account's existing parameters. */
export async function newPasswordSecretFor(kdf: PasswordKdfParams | null, password: string): Promise<{ secret: string; wrappingKey: Uint8Array | null }> {
  if (!kdf || outsidePasswordBounds(password)) return { secret: password, wrappingKey: null };
  const keys = await derivePasswordKeys(password, kdf);
  return { secret: keys.loginSecret, wrappingKey: keys.wrappingKey };
}

/** The account's parameters while signed in, or null for a legacy account or an older server. */
export async function passwordKdfOf(email: string): Promise<PasswordKdfParams | null> {
  const answer = await kdfFor(email);
  return answer?.state === "ready" ? answer.kdf : null;
}

/**
 * Seal this account's keys under a (new) password's wrapping key and save the
 * signed identity. Needs the keys unlocked on this device. Used after a
 * password change, and to repair an envelope a reset left behind.
 */
export async function rewrapKeysForPassword(userId: string, kdf: PasswordKdfParams, wrappingKey: Uint8Array): Promise<boolean> {
  const { privateSession, sealIdentityForPassword } = await import("./private-session");
  const secrets = privateSession(userId);
  if (!secrets) return false;
  const client = await rpc();
  const account = await client.privacy.identity.query({ userId });
  if (!account) return false;
  const identity = { ...account.identity, password: { kdf: structuredClone(kdf), envelope: await sealIdentityForPassword(userId, wrappingKey, secrets) } };
  const signature = await signPrivateChange(secrets.signingPrivateKey, { userId, revision: account.revision, identity });
  await client.privacy.updateIdentity.mutate({ identity, revision: account.revision, signature });
  const { rememberPrivateIdentity } = await import("./private-identity-cache");
  await rememberPrivateIdentity(userId, identity).catch(() => undefined);
  await markKeysCurrent();
  return true;
}

/** The keys open with the current password again: clear a reset's flag. */
async function markKeysCurrent(): Promise<void> {
  if (!serverSupportsNow("auth.passwordKeysRepair")) return;
  try { await (await rpc()).accountPassword.keysRewrapped.mutate(); }
  catch (error) { console.warn("[auth] could not clear the password-reset flag; the next unlock retries it", error); }
  if (keysStale) { keysStale = null; notify(); }
}

/** Sign-up: always the derived login secret, with fresh parameters. */
export async function signUpWithPasswordUnlock<R extends { ok: boolean }>(email: string, password: string, attempt: (secret: string, passwordKdf: string | null) => Promise<R>): Promise<R> {
  forget();
  if (outsidePasswordBounds(password) || !(await supportsPasswordUnlock())) return attempt(password, null);
  const kdf = newPasswordKdf(), keys = await derivePasswordKeys(password, kdf);
  const result = await attempt(keys.loginSecret, JSON.stringify(kdf));
  if (result.ok) pending = { email, origin: getApiOrigin(), until: Date.now() + PENDING_MS, wrappingKey: keys.wrappingKey, kdf, upgrade: null };
  else keys.wrappingKey.fill(0);
  return result;
}

/**
 * What the app should tell the person about their keys right now
 * (components/private-keys-notice.tsx). All of it lives in memory only:
 * - the recovery key of keys created during this sign-in, until it is saved;
 * - keys this device could not open with the password (it was reset), with
 *   the new password's wrapping key held so the keys can be sealed under it
 *   as soon as the recovery key or another unlock opens them;
 * - a reset seen from a device that still holds the keys open.
 */
let recoveryToSave: { userId: string; recoveryKey: string } | null = null;
let keysNeedRecovery: { userId: string; kdf: PasswordKdfParams; wrappingKey: Uint8Array } | null = null;
let keysStale: { userId: string } | null = null;
const noticeListeners = new Set<() => void>();
function notify(): void { for (const listener of noticeListeners) listener(); }
export const subscribePasswordUnlockNotices = (listener: () => void) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; };
export const recoveryKeyToSave = (userId: string): string | null => (recoveryToSave?.userId === userId ? recoveryToSave.recoveryKey : null);
export function recoveryKeySaved(): void { recoveryToSave = null; notify(); }
/** A new recovery key from Settings, until the person confirms they saved it. */
export function offerRecoveryKey(userId: string, recoveryKey: string): void { recoveryToSave = { userId, recoveryKey }; notify(); }
export const passwordKeysNeedRecovery = (userId: string): boolean => keysNeedRecovery?.userId === userId;
export const passwordKeysStale = (userId: string): boolean => keysStale?.userId === userId;
function dropKeysNeedRecovery(): void { keysNeedRecovery?.wrappingKey.fill(0); keysNeedRecovery = null; }

/**
 * Keys that did not open with the password opened another way (recovery key,
 * passkey, a trusted device): seal them under the password they missed.
 */
let repairing: Promise<void> | null = null;
export async function repairKeysAfterUnlock(): Promise<void> {
  const held = keysNeedRecovery;
  if (!held || repairing) return;
  const { privateSession } = await import("./private-session");
  if (!privateSession(held.userId)) return;
  repairing = (async () => {
    try {
      if (await rewrapKeysForPassword(held.userId, held.kdf, held.wrappingKey) && keysNeedRecovery === held) { dropKeysNeedRecovery(); notify(); }
      await openInventoryAndWorkspace(held.userId);
    } catch (error) { console.warn("[auth] could not seal the keys under the new password", error); }
    finally { repairing = null; }
  })();
  await repairing;
}
if (typeof window !== "undefined") {
  void import("./private-session").then(({ subscribePrivateSession }) => subscribePrivateSession(() => { void repairKeysAfterUnlock(); }));
}

/**
 * A device that holds the keys open learns about a reset made elsewhere.
 * Asked once per account and page load; the answer only decides a notice.
 */
const askedStale = new Set<string>();
export async function checkPasswordKeysStale(userId: string): Promise<void> {
  if (askedStale.has(userId) || !serverSupportsNow("auth.passwordKeysRepair")) return;
  askedStale.add(userId);
  try {
    const { stale } = await (await rpc()).accountPassword.keysStatus.query();
    const { privateSession } = await import("./private-session");
    if (stale && privateSession(userId) && !passwordKeysNeedRecovery(userId)) { keysStale = { userId }; notify(); }
  } catch { askedStale.delete(userId); }
}

export class WrongPasswordError extends Error { constructor() { super("wrong-password"); } }

/**
 * The stale notice's answer: the new password, typed on a device whose keys
 * are open. Checked against the server before anything is sealed, so a typo
 * cannot replace the envelope with one nobody can open.
 */
export async function repairKeysWithPassword(userId: string, password: string): Promise<void> {
  const { authClient } = await import("./auth-client");
  const email = authClient.$store.atoms.session.get().data?.user.email ?? (await authClient.getSession()).data?.user.email;
  const kdf = email ? await passwordKdfOf(email) : null;
  if (!kdf) throw new Error("This account has no password parameters");
  const keys = await derivePasswordKeys(password, kdf);
  try {
    const { ok } = await (await rpc()).accountPassword.verify.mutate({ loginSecret: keys.loginSecret });
    if (!ok) throw new WrongPasswordError();
    if (!(await rewrapKeysForPassword(userId, kdf, keys.wrappingKey))) throw new Error("Unlock this account's keys first");
  } finally { keys.wrappingKey.fill(0); }
}

/**
 * With keys, every content request must name a workspace from the trusted
 * inventory (private-content-route.ts); a null "session default" is refused.
 * Resolve the active workspace before the app shows, as the first
 * workspaces.list would a moment later.
 */
async function resolveActiveWorkspaceNow(userId: string): Promise<void> {
  try {
    const client = await rpc();
    const list = await client.workspaces.list.query();
    const { applyWorkspaceList } = await import("./active-workspace");
    await applyWorkspaceList(list as Parameters<typeof applyWorkspaceList>[0], userId);
  } catch { /* The app's own first list will do it. */ }
}

/**
 * Keys just opened on this device: rebuild the signed workspace list from the
 * server when this device has none, then let the app re-read what it may open.
 */
async function openInventoryAndWorkspace(userId: string): Promise<void> {
  const { openPrivateAccountInventorySync, privateAccountInventoryTransport } = await import("./private-inventory-sync");
  const sync = await openPrivateAccountInventorySync(userId);
  try {
    try { await sync.status(); }
    catch (error) {
      const { PrivateAccountInventoryMissingError } = await import("@starter/core");
      if (!(error instanceof PrivateAccountInventoryMissingError)) throw error;
      await sync.bootstrapFromServer(privateAccountInventoryTransport(userId));
    }
  } finally { sync.close(); }
  const { notifyPrivateDeviceAccessChanged } = await import("./private-device-access");
  notifyPrivateDeviceAccessChanged();
  await resolveActiveWorkspaceNow(userId);
}

/**
 * After a session exists (right after sign-in, or after its second factor):
 * finish a legacy upgrade, then open this account's keys with the password,
 * or create them. Never throws: sign-in has already succeeded, and the
 * device-access boundary decides what a half-finished state may show.
 */
export async function finishPasswordUnlock(userId: string): Promise<void> {
  const held = pending;
  if (!held || held.until < Date.now() || held.origin !== getApiOrigin()) { forget(); return; }
  pending = null;
  try {
    const { privateAccountSignedIn } = await import("./private-session");
    if (!(await privateAccountSignedIn(userId))) throw new Error("The signed-in account did not resolve");
    const client = await rpc();
    if (held.upgrade) {
      try { await client.accountPassword.upgrade.mutate(held.upgrade); }
      catch (error) { console.warn("[auth] password upgrade failed; the next sign-in retries it", error); return; }
    }
    const account = await client.privacy.identity.query({ userId });
    if (!account) {
      const { preparePrivateAccountSetup, finishPrivateAccountSetup } = await import("./private-account-setup");
      const setup = await preparePrivateAccountSetup(userId, { password: { kdf: held.kdf, wrappingKey: held.wrappingKey } });
      await finishPrivateAccountSetup(setup);
      recoveryToSave = { userId, recoveryKey: setup.recoveryKey };
      // Fresh keys are sealed under the password just typed.
      if (serverSupportsNow("auth.passwordKeysRepair")) await markKeysCurrent();
      // Deliver the first signed inventory now: another device signing in
      // with the password rebuilds its inventory from this server history.
      const { openPrivateAccountInventorySync } = await import("./private-inventory-sync");
      const sync = await openPrivateAccountInventorySync(userId);
      try { for (let i = 0; i < 8 && (await sync.flushOne()).pending > 0; i++) { /* one version per pass */ } }
      finally { sync.close(); }
      notify();
      await resolveActiveWorkspaceNow(userId);
      return;
    }
    const { privateSession, unlockPrivatePassword } = await import("./private-session");
    const opensWithPassword = async () => {
      if (!account.identity.password) return false;
      try { await unlockPrivatePassword(userId, account.identity, held.wrappingKey); return true; } catch { return false; }
    };
    if (await opensWithPassword()) await markKeysCurrent();
    else {
      // Keys from before password unlock, or an envelope a reset left behind.
      // A device that stayed unlocked repairs it now; elsewhere the notice
      // asks for the recovery key, and the repair runs once the keys open.
      if (privateSession(userId)) await rewrapKeysForPassword(userId, held.kdf, held.wrappingKey);
      if (!privateSession(userId)) {
        dropKeysNeedRecovery();
        keysNeedRecovery = { userId, kdf: structuredClone(held.kdf), wrappingKey: new Uint8Array(held.wrappingKey) };
        notify();
        return;
      }
    }
    await openInventoryAndWorkspace(userId);
  } catch (error) {
    console.warn("[auth] could not open this account's keys after sign-in", error);
  } finally {
    held.wrappingKey.fill(0);
  }
}

/** After a second factor: the session's own user, never throwing. */
export async function finishPasswordUnlockForSession(): Promise<void> {
  try {
    const { authClient } = await import("./auth-client");
    const verified = await authClient.getSession();
    if (verified?.data?.user) await finishPasswordUnlock(verified.data.user.id);
  } catch { forget(); }
}

/** Sign-out and account switches drop anything held for the key step. */
export function forgetPasswordUnlock(): void {
  forget();
  recoveryToSave = null;
  dropKeysNeedRecovery();
  keysStale = null;
  askedStale.clear();
  notify();
}
