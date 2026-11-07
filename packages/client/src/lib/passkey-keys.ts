/**
 * Passkeys open the account keys, like the password does
 * (docs/private-workspace-protocol.md → "Passkeys open the keys").
 *
 * A passkey that supports the WebAuthn PRF extension produces a secret only it
 * can produce again. The keys are sealed under it (`identity.passkeys`, one
 * envelope per credential), so signing in with that passkey opens them on any
 * device. A passkey without PRF still signs in; it cannot hold keys.
 *
 * There is one way to add a passkey (Settings → Account → Passkeys). A passkey
 * added before this, or on a device whose keys were locked, gets its envelope
 * the next time it signs in on a device where the keys are open.
 */
import { signPrivateChange } from "@starter/core";
import { authClient } from "./auth-client";
import { evaluatePrivatePasskey, prfBytes, PRIVATE_PRF_INPUT, privateSession, wrapIdentityWithPrf } from "./private-session";
import { rememberPrivateIdentity } from "./private-identity-cache";

async function rpc() {
  const { getTRPCClient } = await import("./trpc");
  return getTRPCClient();
}

/** What a passkey can do for this account's encrypted data. */
export type PasskeyKeyState = "opens" | "no-prf" | "keys-locked" | "no-keys";

/**
 * Seal the open keys under one passkey's PRF secret, in a signed identity
 * update. Idempotent: a credential that already has an envelope is left alone.
 */
export async function grantPasskey(userId: string, credentialId: string, secret: Uint8Array): Promise<boolean> {
  const current = privateSession(userId);
  if (!current) return false;
  const client = await rpc();
  const account = await client.privacy.identity.query({ userId });
  if (!account) return false;
  if (account.identity.passkeys.some((saved) => saved.credentialId === credentialId)) return true;
  const identity = { ...account.identity, passkeys: [...account.identity.passkeys, { credentialId, envelope: await wrapIdentityWithPrf(userId, secret, account.identity) }] };
  const signature = await signPrivateChange(current.signingPrivateKey, { userId, revision: account.revision, identity });
  if (privateSession(userId) !== current) throw new Error("Private data is locked");
  await client.privacy.updateIdentity.mutate({ identity, revision: account.revision, signature });
  await rememberPrivateIdentity(userId, identity).catch(() => undefined);
  return true;
}

/** Drop a removed passkey's envelope, so a deleted credential opens nothing. */
export async function revokePasskey(userId: string, credentialId: string): Promise<void> {
  const current = privateSession(userId);
  if (!current) return;
  const client = await rpc();
  const account = await client.privacy.identity.query({ userId });
  if (!account || !account.identity.passkeys.some((saved) => saved.credentialId === credentialId)) return;
  const identity = { ...account.identity, passkeys: account.identity.passkeys.filter((saved) => saved.credentialId !== credentialId) };
  const signature = await signPrivateChange(current.signingPrivateKey, { userId, revision: account.revision, identity });
  await client.privacy.updateIdentity.mutate({ identity, revision: account.revision, signature });
  await rememberPrivateIdentity(userId, identity).catch(() => undefined);
}

/**
 * Register a passkey and, when this device's keys are open, seal them under
 * it. Some authenticators report PRF only on use, not at creation, so a
 * missing result is asked for once more with the new credential.
 */
export async function addPasskeyWithKeys(userId: string, name: string | undefined): Promise<PasskeyKeyState> {
  const result = await authClient.passkey.addPasskey({ name, extensions: { prf: { eval: { first: PRIVATE_PRF_INPUT } } }, returnWebAuthnResponse: true } as unknown as Parameters<typeof authClient.passkey.addPasskey>[0]);
  if (result.error || !("webauthn" in result)) throw new Error("Could not register passkey");
  const account = await (await rpc()).privacy.identity.query({ userId }).catch(() => null);
  if (!account) return "no-keys";
  if (!privateSession(userId)) return "keys-locked";
  const credentialId = result.webauthn.response.id;
  let secret = prfBytes((result.webauthn.clientExtensionResults as { prf?: { results?: { first?: unknown } } }).prf?.results?.first);
  if (!secret) {
    try { ({ secret } = await evaluatePrivatePasskey([credentialId])); }
    catch { return "no-prf"; }
  }
  try { return (await grantPasskey(userId, credentialId, secret)) ? "opens" : "keys-locked"; }
  finally { secret.fill(0); }
}

/**
 * After a passkey sign-in with a PRF secret: open the keys with this
 * passkey's envelope, or, when this device already holds them open (it stayed
 * unlocked) and the passkey has none yet, give it one. Then rebuild the
 * device's workspace list like a password sign-in. Never throws: the sign-in
 * itself already succeeded.
 */
export async function finishPasskeyUnlock(userId: string, credentialId: string, secret: Uint8Array): Promise<void> {
  try {
    // Tell the private layer whose session this is now, and let a saved
    // unlock reopen first (as finishPasswordUnlock does).
    const { privateAccountSignedIn, unlockPrivatePrf } = await import("./private-session");
    if (!(await privateAccountSignedIn(userId))) return;
    const account = await (await rpc()).privacy.identity.query({ userId });
    if (!account) return;
    const enrolled = account.identity.passkeys.some((saved) => saved.credentialId === credentialId);
    if (!privateSession(userId) && enrolled) await unlockPrivatePrf(userId, account.identity, credentialId, secret);
    else if (privateSession(userId) && !enrolled) await grantPasskey(userId, credentialId, secret);
    if (!privateSession(userId)) return;
    const { openInventoryAndWorkspace } = await import("./password-unlock");
    await openInventoryAndWorkspace(userId);
  } catch (error) {
    console.warn("[auth] the passkey could not open this account's keys", error);
  }
}
