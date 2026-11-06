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
  return true;
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

/** The recovery key of keys created during this sign-in, until it is saved. */
let recoveryToSave: { userId: string; recoveryKey: string } | null = null;
const recoveryListeners = new Set<() => void>();
export const recoveryKeyToSave = (userId: string): string | null => (recoveryToSave?.userId === userId ? recoveryToSave.recoveryKey : null);
export const subscribeRecoveryKeyToSave = (listener: () => void) => { recoveryListeners.add(listener); return () => { recoveryListeners.delete(listener); }; };
export function recoveryKeySaved(): void { recoveryToSave = null; for (const listener of recoveryListeners) listener(); }

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
      // Deliver the first signed inventory now: another device signing in
      // with the password rebuilds its inventory from this server history.
      const { openPrivateAccountInventorySync } = await import("./private-inventory-sync");
      const sync = await openPrivateAccountInventorySync(userId);
      try { for (let i = 0; i < 8 && (await sync.flushOne()).pending > 0; i++) { /* one version per pass */ } }
      finally { sync.close(); }
      for (const listener of recoveryListeners) listener();
      await resolveActiveWorkspaceNow(userId);
      return;
    }
    const { privateSession, unlockPrivatePassword } = await import("./private-session");
    const opensWithPassword = async () => {
      if (!account.identity.password) return false;
      try { await unlockPrivatePassword(userId, account.identity, held.wrappingKey); return true; } catch { return false; }
    };
    if (!(await opensWithPassword())) {
      // Keys from before password unlock, or an envelope a reset left behind.
      // A device that stayed unlocked repairs it; elsewhere Settings (recovery
      // key or a trusted device) opens the keys.
      if (privateSession(userId)) await rewrapKeysForPassword(userId, held.kdf, held.wrappingKey);
      if (!privateSession(userId)) return;
    }
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
}
