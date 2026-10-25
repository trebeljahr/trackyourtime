import { PRIVATE_PREPARATION_REQUEST_TTL_MS, privateOriginalStageRequestSchema, signedPrivateOriginalStageRequestSchema, type SignedPrivateOriginalStageRequest } from "@starter/shared";
import { signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { privateSourceSessionBinding } from "./source-challenge.js";
/** Explicit one-time authorization to encrypt the exact frozen originals the
 * server already stores. No replacement content, record keys or future edits
 * enter this intent. Old plaintext/key process and storage retirement remain
 * required before declaring conversion server-blind. */
export async function createPrivateOriginalStageRequest(options: {
  directory: VerifiedPrivateDirectory; userId: string; sessionId: string; migrationId: string;
  secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean; now?: number;
}): Promise<SignedPrivateOriginalStageRequest> {
  const { directory, userId, sessionId, migrationId, secrets, current } = options, now = options.now ?? Date.now();
  const check = () => { if (!current()) throw new Error("Private data changed during original staging authorization"); };
  check(); const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  const { server, workspaceId, ownerId } = directory.signed.directory;
  if (ownerId !== userId) throw new Error("Only the verified owner can authorize original conversion");
  const sessionBinding = await privateSourceSessionBinding({ server, userId, sessionId }); check();
  const request = privateOriginalStageRequestSchema.parse({ v: 1, protocol: "trackyourtime-private-original-stage-v1", server, workspaceId, userId, migrationId, directoryDigest: directory.digest, sessionBinding, issuedAt: now, expiresAt: now + PRIVATE_PREPARATION_REQUEST_TTL_MS });
  const signature = await signPrivateChange(access.signingPrivateKey, request); check();
  return signedPrivateOriginalStageRequestSchema.parse({ request, signature });
}
