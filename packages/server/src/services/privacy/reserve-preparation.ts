import { TRPCError } from "@trpc/server";
import { canonicalJson, privateSourceSessionBinding, type PublicKey } from "@starter/core";
import { PRIVATE_PREPARATION_REQUEST_TTL_MS, signedPrivatePreparationReservationSchema, type SignedPrivatePreparationReservation } from "@starter/shared";
import { PrivatePreparationReservation } from "../../models/PrivatePreparationReservation.js";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { beforeBusinessCommit, fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { captureCurrentPreparationDirectory } from "./preparation-directory.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { signedOperatorCheckpointProofSchema, verifyOperatorCheckpointProof, type SignedOperatorCheckpointProof } from "./operator-checkpoint.js";
import { requireReservedPrivatePreparation } from "./reserved-preparation.js";
import { verifyPrivateChange } from "./signatures.js";
/** Internal irreversible hold only, never source retirement or activation.
 * It precedes any account inventory/device pin publication. No public route. */
export async function reservePrivatePreparation(inputScope: { server: string; workspaceId: string; userId: string; sessionId: string }, input: SignedPrivatePreparationReservation, operatorInput: SignedOperatorCheckpointProof, trustedOperatorKey: PublicKey) {
  const scope = { ...inputScope }, consent = signedPrivatePreparationReservationSchema.parse(input), operator = signedOperatorCheckpointProofSchema.parse(operatorInput), key = structuredClone(trustedOperatorKey), { request } = consent;
  if (request.server !== scope.server || request.workspaceId !== scope.workspaceId || request.userId !== scope.userId || request.sessionBinding !== await privateSourceSessionBinding(scope)) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  const fresh = () => {
    const now = Date.now();
    if (request.issuedAt > now + 30_000 || request.expiresAt <= now || request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > PRIVATE_PREPARATION_REQUEST_TTL_MS) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reservation consent expired. Original data was kept." });
  };
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId, ownerId: scope.userId, migrationId: request.migrationId }).lean();
    if (!mode || String(mode._id) !== request.modeId) throw new TRPCError({ code: "NOT_FOUND" });
    if (mode.state === "reserved") {
      const prior = await requireReservedPrivatePreparation(mode, scope.server);
      if (canonicalJson(prior.consent) !== canonicalJson(consent)) throw new TRPCError({ code: "CONFLICT" });
      return { reserved: true as const, root: prior.root, directoryDigest: prior.directoryDigest, reservationId: prior.consent.request.reservationId };
    }
    fresh(); requireActivePrivatePreparation(mode);
    if (mode.preparationProtocol !== "client-v2" || await PrivatePreparationReservation.exists({ workspaceId: scope.workspaceId })) throw new TRPCError({ code: "CONFLICT" });
    // Order reservation against account deletion BEFORE the one-way erasure
    // marker. A deletion that wins this race makes reservation fail instead.
    const people = (await WorkspaceMember.distinct("userId", { workspaceId: scope.workspaceId })).sort();
    for (const userId of people) await fencePrivateAccount(userId);
    const directory = await captureCurrentPreparationDirectory(scope), owner = directory.signed.directory.members.find((member) => member.userId === scope.userId)!;
    if (directory.digest !== request.directoryDigest || mode.directoryDigest !== directory.digest || operator.proof.snapshotRoot !== request.snapshotRoot) throw new TRPCError({ code: "CONFLICT" });
    await verifyPrivateChange(owner.signingPublicKey, request, consent.signature);
    await verifyOperatorCheckpointProof({ ...scope, migrationId: request.migrationId }, operator, key, consent);
    fresh(); requireActivePrivatePreparation(mode);
    beforeBusinessCommit(async () => { fresh(); requireActivePrivatePreparation(mode); });
    await PrivatePreparationReservation.create({ workspaceId: scope.workspaceId, modeId: request.modeId, migrationId: request.migrationId, root: request.snapshotRoot, directoryDigest: directory.digest, ownerId: scope.userId, memberIds: people, ownerSigningPublicKey: owner.signingPublicKey, consent, operator });
    const changed = await PrivateWorkspace.updateOne({ _id: mode._id, state: "migrating" }, { $set: { state: "reserved" } });
    if (changed.matchedCount !== 1) throw new TRPCError({ code: "CONFLICT" });
    return { reserved: true as const, root: request.snapshotRoot, directoryDigest: directory.digest, reservationId: request.reservationId };
  });
}
