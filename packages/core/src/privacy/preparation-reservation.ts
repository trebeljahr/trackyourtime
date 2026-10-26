import { PRIVATE_PREPARATION_REQUEST_TTL_MS, privatePreparationReservationRequestSchema, signedPrivatePreparationReservationSchema } from "@starter/shared";
import { signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { assertPrivateProjectionSnapshot, type VerifiedPrivateProjectionSnapshot } from "./projection-snapshot.js";
import { privateSourceSessionBinding } from "./source-challenge.js";
/** Explicit consent to retain this exact root permanently. No expiry/cancel
 * may discard it once reserved; this alone never publishes a device mode pin. */
export async function createPrivatePreparationReservation(options: {
  snapshot: VerifiedPrivateProjectionSnapshot; directory: VerifiedPrivateDirectory; modeId: string; reservationId: string;
  sessionId: string; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean; now?: number;
}) {
  const { snapshot, directory, modeId, reservationId, sessionId, current } = options, now = options.now ?? Date.now();
  const scope = { server: snapshot.scope.server, userId: snapshot.scope.userId, workspaceId: snapshot.scope.workspaceId }, check = () => {
    if (!current()) throw new Error("Private data changed during reservation consent");
    assertPrivateProjectionSnapshot(snapshot, scope, directory.digest);
  };
  check(); const access = privateReplicaIdentityFromDirectory(directory, scope.userId, options.secrets, current);
  if (directory.signed.directory.ownerId !== scope.userId) throw new Error("Only the verified owner can reserve this root");
  const sessionBinding = await privateSourceSessionBinding({ server: scope.server, userId: scope.userId, sessionId }); check();
  const request = privatePreparationReservationRequestSchema.parse({ v: 1, protocol: "trackyourtime-private-reservation-v1", ...scope, migrationId: snapshot.signed.manifest.migrationId, directoryDigest: directory.digest, modeId, reservationId, snapshotRoot: snapshot.root, sessionBinding, issuedAt: now, expiresAt: now + PRIVATE_PREPARATION_REQUEST_TTL_MS });
  const signature = await signPrivateChange(access.signingPrivateKey, request); check();
  return signedPrivatePreparationReservationSchema.parse({ request, signature });
}
