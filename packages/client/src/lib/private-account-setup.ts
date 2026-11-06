import type { PasswordKdfParams } from "@starter/shared";
import { signPrivateAccountInventory, emptyPrivateTimerCheckpoint, privateRecordDigest } from "@starter/core";
import { newPrivateIdentity, sealIdentityForPassword, installVerifiedPrivateSession, privateAccountId, privateDataOrigin, privateSession, privateSessionVersion, whenPrivateAccountReady } from "./private-session";
import { privateBoundRpc } from "./private-scoped-rpc";
import { privateRoutingRequired, requirePrivateRouting } from "./private-routing-requirement";
import { stagePrivateAccountInventory } from "./private-inventory-staging";
import { stagePrivateAccountTimer } from "./private-timer-staging";
type Draft = Awaited<ReturnType<typeof newPrivateIdentity>>;
type Setup = Draft;
const prepared = new WeakMap<Setup, { draft: Draft; scope: { server: string; userId: string }; signed: Awaited<ReturnType<typeof signPrivateAccountInventory>>; check: () => void; current: () => boolean }>();
/** Explicit first key setup only. Missing inventory after importing existing
 * keys must use trusted-device recovery, never this fresh-standard enrollment.
 * No plaintext record is migrated or changed by setting up account keys. */
export async function preparePrivateAccountSetup(userId: string, options?: { password?: { kdf: PasswordKdfParams; wrappingKey: Uint8Array } }): Promise<Setup> {
  if (await whenPrivateAccountReady() !== userId) throw new Error("Sign in before setting up private keys");
  const scope = { server: privateDataOrigin(), userId }, version = privateSessionVersion();
  const draft = await newPrivateIdentity(userId);
  // Password unlock: the same keys also open with the password on any device.
  if (options?.password) draft.identity.password = { kdf: structuredClone(options.password.kdf), envelope: await sealIdentityForPassword(userId, options.password.wrappingKey, draft.secrets) };
  const check = () => { draft.assertCurrent(); if (privateAccountId() !== userId || privateDataOrigin() !== scope.server || privateSessionVersion() !== version || privateSession(userId)) throw new Error("Private account setup changed before completion"); };
  const current = () => { try { check(); return true; } catch { return false; } };
  check(); if (await privateRoutingRequired(scope)) throw new Error("Restore this account's trusted keys and inventory instead of creating replacement keys"); check();
  const { rpc, supported } = privateBoundRpc({ ...scope, check, current }, "privacy.accountInventory"); supported();
  const rows: unknown = await rpc.workspaces.list.query(); supported();
  if (!Array.isArray(rows) || rows.length > 1000 || rows.some((row) => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id || row.id.length > 100)) throw new Error("Initial workspace list could not be verified");
  const ids = rows.map((row) => row.id as string); if (new Set(ids).size !== ids.length) throw new Error("Initial workspace list is ambiguous");
  const signed = await signPrivateAccountInventory({ ...scope, workspaces: ids.map((workspaceId) => ({ workspaceId, mode: "standard" })), previous: null, signingPrivateKey: draft.secrets.signingPrivateKey, current }); check();
  const value = { ...draft, assertCurrent: check };
  prepared.set(value, { draft: { ...draft, identity: structuredClone(draft.identity), secrets: structuredClone(draft.secrets) }, scope, signed, check, current });
  return value;
}
/** The same prepared request can retry a lost enrollment reply or failed local
 * write. Signed inventory is saved/read back before keys become active. */
export async function finishPrivateAccountSetup(value: Setup) {
  const owned = prepared.get(value); if (!owned) throw new Error("Use this device's original prepared account setup");
  const { draft, scope, signed, check, current } = owned; check();
  const { rpc, supported } = privateBoundRpc({ ...scope, check, current }, "privacy.accountInventory"); supported();
  await rpc.privacy.enroll.mutate({ ...scope, identity: draft.identity }); supported();
  const sync = await stagePrivateAccountInventory(scope, draft.secrets, check);
  try { await sync.enroll(signed); check(); await requirePrivateRouting(scope, current); check(); }
  finally { sync.close(); }
  const timers = await stagePrivateAccountTimer(scope, draft.secrets, check);
  try {
    const state = { v: 1 as const, confirmed: { checkpoint: emptyPrivateTimerCheckpoint(), signed: null }, pending: [], committed: [], conflict: null };
    await timers.restore(state, await privateRecordDigest(state)); check();
  } finally { timers.close(); }
  installVerifiedPrivateSession(scope.userId, draft.identity, draft.secrets); prepared.delete(value);
}
