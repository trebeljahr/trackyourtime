import { TRPCError } from "@trpc/server";
import { privateRecordDigest, privateSourceSessionBinding } from "@starter/core";
import { PRIVATE_PREPARATION_REQUEST_TTL_MS, signedPrivateOriginalStageRequestSchema, type SignedPrivateOriginalStageRequest } from "@starter/shared";
import { PrivateRecord, PrivateWorkspace } from "../../models/PrivateData.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { captureCurrentPreparationDirectory } from "./preparation-directory.js";
import { verifyPrivateChange } from "./signatures.js";
export type OriginalStageScope = { server: string; workspaceId: string; userId: string; migrationId: string };
function lifetime(request: SignedPrivateOriginalStageRequest["request"], fresh: boolean) {
  const now = Date.now();
  if (request.issuedAt > now + 30_000 || request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > PRIVATE_PREPARATION_REQUEST_TTL_MS || (fresh && request.expiresAt <= now)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Original conversion authorization expired or is invalid." });
}
/** Explicit, session/root-signed consent to a one-time existing-source worker.
 * No replacement records are accepted. Never mount this behind the old raw
 * write/staging route. It does not authorize cutover or future private edits. */
export async function authorizePrivateOriginalStage(inputScope: Omit<OriginalStageScope, "migrationId"> & { sessionId: string }, input: SignedPrivateOriginalStageRequest) {
  const scope = { ...inputScope }, signed = signedPrivateOriginalStageRequestSchema.parse(input), { request } = signed;
  if (request.server !== scope.server || request.workspaceId !== scope.workspaceId || request.userId !== scope.userId || request.sessionBinding !== await privateSourceSessionBinding(scope)) throw new TRPCError({ code: "NOT_FOUND" });
  lifetime(request, true);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId, migrationId: request.migrationId, ownerId: scope.userId }).lean();
    if (!mode || mode.preparationProtocol !== "client-v2") throw new TRPCError({ code: "NOT_FOUND" });
    requireActivePrivatePreparation(mode);
    const directory = await captureCurrentPreparationDirectory(scope);
    if (directory.digest !== request.directoryDigest || mode.directoryDigest !== directory.digest) throw new TRPCError({ code: "CONFLICT" });
    const owner = directory.signed.directory.members.find((member) => member.userId === scope.userId)!;
    await verifyPrivateChange(owner.signingPublicKey, request, signed.signature);
    if (mode.originalStage) {
      const current = await captureAuthorizedOriginalStage({ ...scope, migrationId: request.migrationId });
      return { status: current.complete ? "complete" as const : "working" as const };
    }
    if (await PrivateRecord.exists({ workspaceId: scope.workspaceId })) throw new TRPCError({ code: "CONFLICT", message: "Untracked preparation ciphertext needs recovery. Original data was kept." });
    lifetime(request, true);
    const saved = await PrivateWorkspace.updateOne({ _id: mode._id, originalStage: null }, { $set: { originalStage: { signed, cursor: 0, complete: false } } });
    if (saved.matchedCount !== 1) throw new TRPCError({ code: "CONFLICT" });
    return { status: "queued" as const };
  });
}
/** Server-internal job capture. Never return cursor/request metadata through
 * an owner API: complete private counts and source details remain internal. */
export async function captureAuthorizedOriginalStage(inputScope: OriginalStageScope) {
  const scope = { ...inputScope };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId, migrationId: scope.migrationId, ownerId: scope.userId }).lean();
    if (!mode || mode.preparationProtocol !== "client-v2" || !mode.originalStage) throw new TRPCError({ code: "NOT_FOUND" });
    requireActivePrivatePreparation(mode);
    const stage = mode.originalStage;
    if (!Number.isSafeInteger(stage.cursor) || stage.cursor < 0 || stage.cursor > 400_000 || typeof stage.complete !== "boolean") throw new TRPCError({ code: "PRECONDITION_FAILED" });
    const signed = signedPrivateOriginalStageRequestSchema.parse(stage.signed), { request } = signed;
    if (request.server !== scope.server || request.workspaceId !== scope.workspaceId || request.userId !== scope.userId || request.migrationId !== scope.migrationId) throw new TRPCError({ code: "CONFLICT" });
    lifetime(request, false); // Started while fresh; work remains bounded by the lease.
    const directory = await captureCurrentPreparationDirectory(scope);
    if (directory.digest !== mode.directoryDigest || directory.digest !== request.directoryDigest) throw new TRPCError({ code: "CONFLICT" });
    const owner = directory.signed.directory.members.find((member) => member.userId === scope.userId)!;
    await verifyPrivateChange(owner.signingPublicKey, request, signed.signature);
    return { modeId: String(mode._id), cursor: stage.cursor, complete: stage.complete, authorizationDigest: await privateRecordDigest(request) };
  });
}
/** Called only from the ciphertext publication transaction. A failed cursor
 * acknowledgement must roll back the same batch, not lose accepted work. */
export async function advanceAuthorizedOriginalStage(scope: OriginalStageScope, authorizationDigest: string, modeId: string, from: number, to: number, complete: boolean) {
  return withBusinessTransaction(async () => {
    const state = await captureAuthorizedOriginalStage(scope);
    if (state.modeId !== modeId || state.authorizationDigest !== authorizationDigest || state.cursor < from || !Number.isSafeInteger(to) || to < from || to > 400_000) throw new TRPCError({ code: "CONFLICT" });
    if (state.cursor > from || state.complete) return;
    const saved = await PrivateWorkspace.updateOne({ _id: modeId, workspaceId: scope.workspaceId, migrationId: scope.migrationId, ownerId: scope.userId, "originalStage.cursor": from, "originalStage.complete": false }, { $set: { "originalStage.cursor": to, "originalStage.complete": complete } });
    if (saved.matchedCount !== 1) throw new TRPCError({ code: "CONFLICT" });
  });
}
