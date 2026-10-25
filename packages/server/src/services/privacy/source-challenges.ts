import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, privateMemberKeyFingerprint, privateSourceSessionBinding, type PrivateSourceScope } from "@starter/core";
import { PRIVATE_SOURCE_CHALLENGE_TTL_MS, privateSourceChallengeSchema, signedPrivateSourceChallengeSchema, type SignedPrivateSourceChallenge } from "@starter/shared";
import { PrivateAccount, PrivateSourceChallengeRequest, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { combinedWorkspaceRecovery } from "./combined-recovery.js";
import { personalMigrationSource } from "./personal-migration.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { verifyPrivateChange } from "./signatures.js";
async function requireSourceScope(scope: PrivateSourceScope) {
  if (new URL(scope.server).origin !== scope.server || !["https:", "http:"].includes(new URL(scope.server).protocol)) throw new TRPCError({ code: "BAD_REQUEST" });
  const member = await WorkspaceMember.findOne({ workspaceId: scope.workspaceId, userId: scope.userId }).lean();
  if (!member) throw new TRPCError({ code: "NOT_FOUND" });
  if (scope.purpose === "workspace-originals" && member.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
  const mode = await PrivateWorkspace.findOne({ workspaceId: scope.workspaceId }).lean();
  if (mode) {
    requireActivePrivatePreparation(mode);
    if (mode.migrationId !== scope.migrationId || (scope.purpose === "personal-originals" && !mode.supplementRevision)) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  } else if (scope.migrationId !== null || scope.purpose === "personal-originals") throw new TRPCError({ code: "PRECONDITION_FAILED" });
}
/** Internal controller boundary only. A future router must build server,
 * account/session and workspace scope from authenticated context, not input.
 * Bounded transient challenges contain no originals or plaintext checksums. */
export async function createPrivateSourceChallenge(scope: PrivateSourceScope) {
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  const sessionBinding = await privateSourceSessionBinding({ server: scope.server, userId: scope.userId, sessionId: scope.sessionId });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId); await requireSourceScope(scope);
    // Shares the account-key contention point with directory/key changes.
    const account = await PrivateAccount.findOneAndUpdate({ userId: scope.userId }, { $inc: { keySerial: 1 } }).lean();
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set up private data keys first." });
    const now = Date.now();
    await PrivateSourceChallengeRequest.deleteMany({ userId: scope.userId, expiresAt: { $lte: new Date(now) } });
    if (await PrivateSourceChallengeRequest.countDocuments({ userId: scope.userId, expiresAt: { $gt: new Date(now) } }) >= 3) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
    const keyFingerprint = await privateMemberKeyFingerprint(scope.server, { userId: scope.userId, ...account.identity });
    const challenge = privateSourceChallengeSchema.parse({ v: 1, protocol: "trackyourtime-private-source-challenge-v1", requestId: randomUUID(), server: scope.server, userId: scope.userId, workspaceId: scope.workspaceId, purpose: scope.purpose, migrationId: scope.migrationId, sessionBinding, keyFingerprint, issuedAt: now, expiresAt: now + PRIVATE_SOURCE_CHALLENGE_TTL_MS });
    await PrivateSourceChallengeRequest.create({ _id: challenge.requestId, userId: scope.userId, workspaceId: scope.workspaceId, challenge, expiresAt: new Date(challenge.expiresAt) });
    return challenge;
  });
}
/** Login alone cannot consume a challenge. Signature, root/session binding,
 * live role/mode and expiry are rechecked under one transaction with the source
 * read. Concurrent/replayed consumption releases originals at most once.
 * No public endpoint is mounted and conversion remains disabled. */
export async function readPrivateMigrationOriginals(scope: PrivateSourceScope, input: SignedPrivateSourceChallenge) {
  const signed = signedPrivateSourceChallengeSchema.parse(input), { challenge } = signed;
  if (challenge.server !== scope.server || challenge.workspaceId !== scope.workspaceId || challenge.userId !== scope.userId || challenge.purpose !== scope.purpose || challenge.migrationId !== scope.migrationId || challenge.sessionBinding !== await privateSourceSessionBinding({ server: scope.server, userId: scope.userId, sessionId: scope.sessionId })) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId); await requireSourceScope(scope);
    const account = await PrivateAccount.findOneAndUpdate({ userId: scope.userId }, { $inc: { keySerial: 1 } }).lean();
    if (!account || await privateMemberKeyFingerprint(scope.server, { userId: scope.userId, ...account.identity }) !== challenge.keyFingerprint) throw new TRPCError({ code: "FORBIDDEN" });
    const stored = await PrivateSourceChallengeRequest.findOne({ _id: challenge.requestId, userId: scope.userId, workspaceId: scope.workspaceId, expiresAt: { $gt: new Date() } }).lean();
    if (!stored || canonicalJson(stored.challenge) !== canonicalJson(challenge)) throw new TRPCError({ code: "NOT_FOUND" });
    await verifyPrivateChange(account.identity.signingPublicKey, challenge, signed.signature);
    const now = Date.now();
    if (challenge.expiresAt <= now || challenge.issuedAt > now + 30_000 || challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > PRIVATE_SOURCE_CHALLENGE_TTL_MS) throw new TRPCError({ code: "NOT_FOUND" });
    const consumed = await PrivateSourceChallengeRequest.deleteOne({ _id: challenge.requestId, userId: scope.userId });
    if (consumed.deletedCount !== 1) throw new TRPCError({ code: "NOT_FOUND" });
    return scope.purpose === "workspace-originals"
      ? combinedWorkspaceRecovery(scope.workspaceId, scope.userId, scope.server)
      : personalMigrationSource({ server: scope.server, workspaceId: scope.workspaceId, userId: scope.userId, migrationId: scope.migrationId! });
  });
}
