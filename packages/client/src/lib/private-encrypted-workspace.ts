/**
 * Create a workspace that is encrypted from its first record (early access;
 * docs/private-workspace-protocol.md → "Creating an encrypted workspace").
 *
 * This device signs the owner-only directory and the initial projection (the
 * encrypted name) with the account keys, the server stores them, and the
 * account's signed workspace list gains the workspace as encrypted. Opening
 * it then goes through `openPrivateWorkspaceSession`, which fetches and
 * verifies the directory and projection like any encrypted workspace.
 */
import { prepareEncryptedWorkspace } from "@starter/core";
import { assertIdentityKeys, privateDataOrigin, privateOperationScope, privateSession } from "./private-session";

export class EncryptedWorkspaceUnavailableError extends Error {
  constructor() { super("Unlock this account's keys before creating an encrypted workspace"); this.name = "EncryptedWorkspaceUnavailableError"; }
}

export async function createEncryptedWorkspace(userId: string, input: { name: string; currency: string; weekStartsOn: 0 | 1 }): Promise<{ workspaceId: string }> {
  const secrets = privateSession(userId);
  if (!secrets) throw new EncryptedWorkspaceUnavailableError();
  const assertCurrent = privateOperationScope(userId);
  const current = () => { try { assertCurrent(); return privateSession(userId) === secrets; } catch { return false; } };
  const { getTRPCClient } = await import("./trpc");
  const client = getTRPCClient();
  const account = await client.privacy.identity.query({ userId });
  if (!account) throw new EncryptedWorkspaceUnavailableError();
  assertIdentityKeys(account.identity, secrets);
  const workspaceId = crypto.randomUUID();
  const prepared = await prepareEncryptedWorkspace({
    server: privateDataOrigin(), workspaceId, userId, name: input.name, createdAt: new Date().toISOString(), currency: input.currency, weekStartsOn: input.weekStartsOn,
    reportRangeTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    publicKey: account.identity.publicKey, signingPublicKey: account.identity.signingPublicKey, secrets, current,
  });
  if (!current()) throw new Error("Private data changed while preparing the workspace");
  await client.privacy.createEncryptedWorkspace.mutate({ workspaceId, currency: input.currency, weekStartsOn: input.weekStartsOn, directory: prepared.signedDirectory, root: prepared.root, records: prepared.records });
  // List it as encrypted in the signed workspace list, and deliver that
  // version, so no device reads the new workspace as a standard one.
  const { openPrivateAccountInventorySync } = await import("./private-inventory-sync");
  const sync = await openPrivateAccountInventorySync(userId);
  try {
    const profile = await sync.read();
    await sync.update([...profile.inventory.signed.inventory.workspaces, { workspaceId, mode: "encrypted", signedPolicy: prepared.signedPolicy }]);
    for (let i = 0; i < 8 && (await sync.flushOne()).pending > 0; i++) { /* one version per pass */ }
  } finally { sync.close(); }
  return { workspaceId };
}
