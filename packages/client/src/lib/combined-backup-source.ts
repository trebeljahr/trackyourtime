import { signPrivateSourceChallenge, verifyCombinedWorkspaceRecoveryArchive } from "@starter/core";
import type { SignedPrivateSourceChallenge } from "@starter/shared";
import { getSession } from "./auth-client";
import { privateDataOrigin, privateOperationScope, privateSession } from "./private-session";
export type CombinedBackupSource = {
  challenge: () => Promise<unknown>;
  originals: (proof: SignedPrivateSourceChallenge) => Promise<unknown>;
};
/** Standard-mode backup source only. Never fall back to a partial legacy
 * export if signature, session, origin or supported API changes. Call only
 * after folder permission and schedule checks, so idle jobs read no originals. */
export async function readCombinedBackupSource(userId: string, workspaceId: string, transport: CombinedBackupSource, signal?: AbortSignal) {
  const server = privateDataOrigin(), root = privateSession(userId), capture = privateOperationScope(userId), { challenge, originals } = transport;
  const check = () => { capture(); if (privateSession(userId) !== root || signal?.aborted) throw new Error("Private data changed during backup"); };
  check(); if (!root) throw new Error("Unlock private data before reading backup originals");
  const current = () => { try { check(); return true; } catch { return false; } };
  const session = await getSession({ query: { disableCookieCache: true }, fetchOptions: { signal } }); check();
  if (session.error || !session.data?.session.id || session.data.user.id !== userId) throw new Error("A current account login is required for backup");
  const scope = { server, workspaceId, userId, sessionId: session.data.session.id, purpose: "workspace-originals" as const, migrationId: null };
  const request = await challenge(); check();
  const proof = await signPrivateSourceChallenge(request, scope, root, current); check();
  const source = await originals(proof); check();
  const archive = await verifyCombinedWorkspaceRecoveryArchive(source, { server, ownerId: userId, workspaceId }); check();
  return archive;
}
