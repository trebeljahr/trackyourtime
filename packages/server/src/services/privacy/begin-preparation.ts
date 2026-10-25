import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import { partitionPrivateRecovery, partitionPrivateRecoverySupplement, privateRecordDigest, privateSourceSessionBinding } from "@starter/core";
import { PRIVATE_PREPARATION_REQUEST_TTL_MS, RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, signedPrivatePreparationRequestSchema, type SignedPrivatePreparationRequest } from "@starter/shared";
import { PrivateAccount, PrivateMigrationReceipt, PrivatePreparationRequest, PrivateProjectionReader, PrivateProjectionRoot, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateSourceChallengeRequest, PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { fenceWorkspace, supportsBusinessTransactions, transactionSession, withBusinessTransaction } from "../business-transaction.js";
import { assertPrivateStorageHeadroom } from "../storage-quota.js";
import { captureCurrentPreparationDirectory } from "./preparation-directory.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { estimatePrivateMigrationStorage } from "./migration-preflight.js";
import { workspaceRecovery } from "./recovery.js";
import { capturePrivateMigrationSupplement, workspaceRecoverySupplement } from "./recovery-supplement.js";
import { verifyPrivateChange } from "./signatures.js";
type Scope = { server: string; workspaceId: string; userId: string; sessionId: string };
function currentRequest(request: SignedPrivatePreparationRequest["request"]) {
  const now = Date.now();
  if (request.issuedAt > now + 30_000 || request.expiresAt <= now || request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > PRIVATE_PREPARATION_REQUEST_TTL_MS) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Preparation authorization expired. Original data was kept." });
}
/** Internal only: create a bounded lease after signed explicit owner intent and
 * preflight. No public route, client staging, backup approval or cutover is
 * enabled. Complete original checksums remain inside the server. */
export async function beginPrivateClientPreparation(inputScope: Scope, input: SignedPrivatePreparationRequest) {
  const scope = { ...inputScope }, signed = signedPrivatePreparationRequestSchema.parse(input), { request } = signed;
  const { server, workspaceId, userId } = scope;
  if (new URL(server).origin !== server || !["https:", "http:"].includes(new URL(server).protocol)) throw new TRPCError({ code: "BAD_REQUEST" });
  if (request.server !== server || request.workspaceId !== workspaceId || request.userId !== userId || request.sessionBinding !== await privateSourceSessionBinding(scope)) throw new TRPCError({ code: "NOT_FOUND" });
  currentRequest(request);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  const nonceId = await privateRecordDigest({ protocol: "trackyourtime-preparation-nonce-v1", server, userId, migrationId: request.migrationId });
  const requestDigest = await privateRecordDigest(request);
  return withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId); currentRequest(request);
    const directory = await captureCurrentPreparationDirectory(scope);
    if (directory.digest !== request.directoryDigest) throw new TRPCError({ code: "CONFLICT", message: "Workspace keys changed. Verify them again before preparation." });
    const owner = directory.signed.directory.members.find((member) => member.userId === userId)!;
    await verifyPrivateChange(owner.signingPublicKey, request, signed.signature);
    // Account fence serializes bounded nonce creation across owned workspaces.
    const account = await PrivateAccount.updateOne({ userId }, { $inc: { keySerial: 1 } });
    if (account.matchedCount !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    const prior = await PrivatePreparationRequest.findById(nonceId).lean();
    const mode = await PrivateWorkspace.findOne({ workspaceId }).lean();
    if (prior && (prior.workspaceId !== workspaceId || prior.userId !== userId || prior.migrationId !== request.migrationId || prior.requestDigest !== requestDigest || !mode)) throw new TRPCError({ code: "CONFLICT", message: "Preparation was canceled or this request was already used. Make a fresh request." });
    if (mode) {
      if (!prior || mode.migrationId !== request.migrationId || mode.ownerId !== userId || mode.preparationProtocol !== "client-v2" || mode.directoryDigest !== directory.digest) throw new TRPCError({ code: "CONFLICT" });
      requireActivePrivatePreparation(mode);
    }
    const source = await workspaceRecovery(workspaceId, userId, true), supplement = await capturePrivateMigrationSupplement(workspaceId, userId);
    const ownSource = await workspaceRecovery(workspaceId, userId), ownSupplement = await workspaceRecoverySupplement(workspaceId, userId);
    if (ownSource.sourceRevision !== request.sourceRevision || ownSupplement.sourceRevision !== request.supplementRevision || (mode && (mode.sourceRevision !== source.sourceRevision || mode.supplementRevision !== supplement.sourceRevision))) throw new TRPCError({ code: "CONFLICT", message: "Original data changed. Make a fresh backup before preparation." });
    if (Buffer.byteLength(JSON.stringify({ source, supplement })) + 2048 > RECOVERY_MAX_BYTES || [...Object.values(source.collections), ...Object.values(supplement.collections)].reduce((sum, rows) => sum + rows.length, 0) > RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Combined originals exceed recovery limits. Source data was kept." });
    if (await mongoose.connection.db!.collection("timeentries").countDocuments({ workspaceId, end: null }, { session: transactionSession() })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stop all workspace timers before preparation." });
    if (mode) return { migrationId: mode.migrationId, directoryDigest: directory.digest, leaseUntil: mode.leaseUntil.toISOString() };
    for (const exists of [() => PrivateRecord.exists({ workspaceId }), () => PrivateSnapshotChunk.exists({ workspaceId }), () => PrivateSnapshotReader.exists({ workspaceId }), () => PrivateProjectionRoot.exists({ workspaceId }), () => PrivateProjectionReader.exists({ workspaceId }), () => PrivateWorkspaceCommit.exists({ workspaceId }), () => PrivateMigrationReceipt.exists({ workspaceId })]) if (await exists()) throw new TRPCError({ code: "CONFLICT", message: "Existing private work needs recovery before a new preparation." });
    const now = Date.now();
    await PrivatePreparationRequest.deleteMany({ userId, expiresAt: { $lte: new Date(now) } });
    if (await PrivatePreparationRequest.countDocuments({ userId, expiresAt: { $gt: new Date(now) } }) >= 3) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
    const plain = [...partitionPrivateRecovery(source), ...partitionPrivateRecoverySupplement(supplement)];
    await assertPrivateStorageHeadroom(workspaceId, estimatePrivateMigrationStorage(workspaceId, plain, directory.signed.directory.members).additionalBytes);
    currentRequest(request);
    const leaseUntil = new Date(Date.now() + 3_600_000);
    await PrivatePreparationRequest.create({ _id: nonceId, userId, workspaceId, migrationId: request.migrationId, requestDigest, expiresAt: new Date(request.expiresAt) });
    await PrivateWorkspace.create({ workspaceId, ownerId: userId, state: "migrating", revision: 0, migrationId: request.migrationId, sourceRevision: source.sourceRevision, supplementRevision: supplement.sourceRevision, directoryDigest: directory.digest, preparationProtocol: "client-v2", leaseUntil });
    await PrivateSourceChallengeRequest.deleteMany({ workspaceId });
    return { migrationId: request.migrationId, directoryDigest: directory.digest, leaseUntil: leaseUntil.toISOString() };
  });
}
