import { PRIVATE_SOURCE_CHALLENGE_TTL_MS, privateSourceChallengeSchema, type PrivateSourceChallenge, type SignedPrivateSourceChallenge } from "@starter/shared";
import { signPrivateChange, type PublicKey } from "./crypto.js";
import { privateMemberKeyFingerprint } from "./directory.js";
import { privateRecordDigest } from "./workspace-edits.js";

export type PrivateSourceScope = Pick<PrivateSourceChallenge, "server" | "workspaceId" | "userId" | "purpose" | "migrationId"> & { sessionId: string };
export function privateSourceSessionBinding(scope: Pick<PrivateSourceScope, "server" | "userId" | "sessionId">): Promise<string> {
  if (!scope.sessionId || scope.sessionId.length > 256) throw new Error("A current authenticated session is required");
  return privateRecordDigest({ protocol: "trackyourtime-private-source-session-v1", server: scope.server, userId: scope.userId, sessionId: scope.sessionId });
}
/** Sign only an explicitly selected source operation for this unlocked root
 * and current login session. The session token and private keys never appear
 * in the signed payload. This does not grant access to other creators' data. */
export async function signPrivateSourceChallenge(input: unknown, scope: PrivateSourceScope, secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }, current: () => boolean, now = Date.now()): Promise<SignedPrivateSourceChallenge> {
  const challenge = privateSourceChallengeSchema.parse(input);
  const check = () => { if (!current()) throw new Error("Private data changed during source authorization"); };
  check();
  if (new URL(scope.server).origin !== scope.server || !["https:", "http:"].includes(new URL(scope.server).protocol) || challenge.server !== scope.server || challenge.userId !== scope.userId || challenge.workspaceId !== scope.workspaceId || challenge.purpose !== scope.purpose || challenge.migrationId !== scope.migrationId || challenge.issuedAt > now + 30_000 || challenge.expiresAt <= now || challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > PRIVATE_SOURCE_CHALLENGE_TTL_MS) throw new Error("Source challenge belongs to another operation or has expired");
  const binding = await privateSourceSessionBinding({ server: scope.server, userId: scope.userId, sessionId: scope.sessionId }); check();
  const fingerprint = await privateMemberKeyFingerprint(scope.server, { userId: scope.userId, publicKey: secrets.privateKey, signingPublicKey: secrets.signingPrivateKey }); check();
  if (challenge.sessionBinding !== binding || challenge.keyFingerprint !== fingerprint || !secrets.privateKey.d || !secrets.signingPrivateKey.d) throw new Error("Source challenge does not match this unlocked account and session");
  const signature = await signPrivateChange(secrets.signingPrivateKey, challenge); check();
  return { challenge, signature };
}
