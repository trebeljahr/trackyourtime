import { TRPCError } from "@trpc/server";
import { signedPrivatePreparationReservationSchema } from "@starter/shared";
import { PrivatePreparationReservation } from "../../models/PrivatePreparationReservation.js";
import { verifyPrivateChange } from "./signatures.js";
/** Already-committed consent remains valid after its original authorization and
 * preparation leases expire. Never use this to create a new reservation. */
export async function requireReservedPrivatePreparation(mode: { _id: unknown; workspaceId: string; state: string; ownerId: string; migrationId: string; directoryDigest: string | null; revision: number; head: string | null; backupVerified: boolean }, server: string) {
  const row = await PrivatePreparationReservation.findOne({ workspaceId: mode.workspaceId }).lean();
  if (!row || mode.state !== "reserved" || mode.revision !== 0 || mode.head !== null || mode.backupVerified || row.modeId !== String(mode._id) || row.migrationId !== mode.migrationId || row.ownerId !== mode.ownerId || row.directoryDigest !== mode.directoryDigest) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The durable preparation reservation is missing or inconsistent. Frozen data was kept." });
  const { request, signature } = signedPrivatePreparationReservationSchema.parse(row.consent);
  if (request.server !== server || request.workspaceId !== row.workspaceId || request.userId !== row.ownerId || request.modeId !== row.modeId || request.migrationId !== row.migrationId || request.snapshotRoot !== row.root || request.directoryDigest !== row.directoryDigest || row.ownerSigningPublicKey.d) throw new TRPCError({ code: "CONFLICT" });
  await verifyPrivateChange(row.ownerSigningPublicKey, request, signature);
  return row;
}
