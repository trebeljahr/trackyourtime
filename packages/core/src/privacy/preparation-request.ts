import { PRIVATE_PREPARATION_REQUEST_TTL_MS, privatePreparationRequestSchema, signedPrivatePreparationRequestSchema, type CombinedWorkspaceRecoveryArchive, type SignedPrivatePreparationRequest } from "@starter/shared";
import { signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { verifyCombinedWorkspaceRecoveryArchive } from "./combined-recovery.js";
import { privateSourceSessionBinding } from "./source-challenge.js";

/** Separate explicit preparation intent, never a side effect of reading a
 * backup. The owner signs only their readable source checksums; peer originals
 * stay private. The server must preflight before creating its lease. */
export async function createPrivatePreparationRequest(options: {
  archive: CombinedWorkspaceRecoveryArchive; directory: VerifiedPrivateDirectory; userId: string;
  sessionId: string; migrationId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey };
  current: () => boolean; now?: number;
}): Promise<SignedPrivatePreparationRequest> {
  const { directory, userId, sessionId, migrationId, secrets, current } = options, now = options.now ?? Date.now();
  const check = () => { if (!current()) throw new Error("Private data changed during preparation authorization"); };
  check(); const access = privateReplicaIdentityFromDirectory(directory, userId, secrets, current);
  const { server, workspaceId, ownerId } = directory.signed.directory;
  if (ownerId !== userId) throw new Error("Only the verified owner can authorize workspace preparation");
  const source = structuredClone(options.archive);
  const archive = await verifyCombinedWorkspaceRecoveryArchive(source, { server, ownerId: userId, workspaceId }); check();
  const sessionBinding = await privateSourceSessionBinding({ server, userId, sessionId }); check();
  const request = privatePreparationRequestSchema.parse({ v: 1, protocol: "trackyourtime-private-preparation-v2", server, workspaceId, userId, migrationId, directoryDigest: directory.digest, sessionBinding, sourceRevision: archive.snapshot.sourceRevision, supplementRevision: archive.supplement.sourceRevision, issuedAt: now, expiresAt: now + PRIVATE_PREPARATION_REQUEST_TTL_MS });
  const signature = await signPrivateChange(access.signingPrivateKey, request); check();
  return signedPrivatePreparationRequestSchema.parse({ request, signature });
}
