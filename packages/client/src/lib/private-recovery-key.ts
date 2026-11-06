import { signPrivateChange } from "@starter/core";
import { assertIdentityKeys, newRecoveryEnvelope, privateOperationScope, privateSession } from "./private-session";
import { rememberPrivateIdentity } from "./private-identity-cache";
import { offerRecoveryKey } from "./password-unlock";

/**
 * Replace the account's recovery key while its keys are open on this device.
 * The old key stops working once the signed identity is saved. The new key is
 * held in memory and shown by the recovery key card until the person confirms
 * they saved it; nothing stores it on the device or the server.
 */
export async function replaceRecoveryKey(userId: string): Promise<string> {
  const secrets = privateSession(userId);
  if (!secrets) throw new Error("Unlock this account's keys first");
  const assertCurrent = privateOperationScope(userId);
  const { getTRPCClient } = await import("./trpc");
  const client = getTRPCClient();
  const account = await client.privacy.identity.query({ userId });
  if (!account) throw new Error("This account has no keys yet");
  assertIdentityKeys(account.identity, secrets);
  const { recovery, recoveryKey } = await newRecoveryEnvelope(userId, secrets);
  const identity = { ...account.identity, recovery };
  const signature = await signPrivateChange(secrets.signingPrivateKey, { userId, revision: account.revision, identity });
  assertCurrent(); if (privateSession(userId) !== secrets) throw new Error("Private data is locked");
  await client.privacy.updateIdentity.mutate({ identity, revision: account.revision, signature });
  await rememberPrivateIdentity(userId, identity, recoveryKey).catch(() => undefined);
  offerRecoveryKey(userId, recoveryKey);
  return recoveryKey;
}
