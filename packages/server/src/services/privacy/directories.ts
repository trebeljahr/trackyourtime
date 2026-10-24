import { TRPCError } from "@trpc/server";
import { canonicalJson, privateRecordDigest, verifyPrivateWorkspaceDirectory, type PrivateDirectoryTrust, type PublicKey } from "@starter/core";
import { signedPrivateDirectorySchema, type SignedPrivateDirectory } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { verifyPrivateChange } from "./signatures.js";
const MAX_BYTES = 256 * 1024, MAX_REVISIONS = 10_000;
type Scope = { server: string; workspaceId: string; userId: string };
const coordinates = ({ kty, crv, x, y }: PublicKey) => ({ kty, crv, x, y });
/** Internal preparation engine. Public mutations remain behind the workspace
 * rollout guard. Encrypted-mode transitions need atomic key regrant/recovery
 * history first; a directory change alone must never strand existing records. */
export async function commitPrivateDirectory(scope: Scope, input: SignedPrivateDirectory): Promise<{ revision: number; digest: string }> {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
  const signed = signedPrivateDirectorySchema.parse(input), directory = signed.directory;
  const origin = new URL(scope.server);
  if (origin.origin !== scope.server || !["https:", "http:"].includes(origin.protocol) || directory.server !== scope.server || directory.workspaceId !== scope.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "Directory belongs to another server or workspace." });
  if (directory.revision > MAX_REVISIONS) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace key history needs an explicit archival checkpoint." });
  const digest = await privateRecordDigest(directory);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace key verification requires a MongoDB replica set." });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(scope.workspaceId);
    const members = await WorkspaceMember.find({ workspaceId: scope.workspaceId }).sort({ userId: 1 }).lean();
    const actor = members.find((member) => member.userId === scope.userId);
    if (!actor) throw new TRPCError({ code: "NOT_FOUND" });
    const existing = await PrivateDirectory.findOne({ workspaceId: scope.workspaceId, revision: directory.revision }).lean();
    if (existing) {
      if (existing.digest !== digest || existing.signed.signerId !== signed.signerId) throw new TRPCError({ code: "CONFLICT", message: "Workspace key history changed. Keep your verified checkpoint." });
      await verifyPrivateChange(existing.signerPublicKey, { protocol: "trackyourtime-workspace-directory-v1", directory, signerId: signed.signerId }, signed.signature);
      return { revision: existing.revision, digest: existing.digest };
    }
    if (await PrivateWorkspace.exists({ workspaceId: scope.workspaceId })) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Existing encrypted records require a verified key regrant before sharing changes." });
    const previous = await PrivateDirectory.findOne({ workspaceId: scope.workspaceId }).sort({ revision: -1 }).lean();
    const accounts = await PrivateAccount.find({ userId: { $in: members.map((member) => member.userId) } }).lean();
    // Serialize the captured key set against account-key rotation. A stale
    // transaction retries instead of committing a directory of replaced keys.
    await PrivateAccount.updateMany({ userId: { $in: members.map((member) => member.userId) } }, { $inc: { keySerial: 1 } });
    const expected = members.map((member) => {
      const identity = accounts.find((account) => account.userId === member.userId)?.identity;
      if (!identity) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every member must enroll private-data keys first." });
      return { userId: member.userId, role: member.role, canViewOthersTime: member.role === "owner" || member.canViewOthersTime === true, canViewOthersMoney: member.role === "owner" || member.canViewOthersMoney === true, publicKey: coordinates(identity.publicKey), signingPublicKey: coordinates(identity.signingPublicKey) };
    });
    const actual = directory.members.map((member) => ({ ...member, publicKey: coordinates(member.publicKey), signingPublicKey: coordinates(member.signingPublicKey) }));
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new TRPCError({ code: "CONFLICT", message: "Member keys or permissions changed. Verify them again before preparing encryption." });
    const owner = expected.find((member) => member.userId === directory.ownerId);
    if (!owner || owner.role !== "owner" || (!previous && (actor.role !== "owner" || directory.ownerId !== scope.userId))) throw new TRPCError({ code: "FORBIDDEN" });
    const priorOwner = previous?.signed.directory.members.find((member) => member.userId === previous.signed.directory.ownerId);
    const trust: PrivateDirectoryTrust = previous
      ? { ownerId: previous.signed.directory.ownerId, signingPublicKey: priorOwner!.signingPublicKey, revision: previous.revision, digest: previous.digest }
      : { ownerId: scope.userId, signingPublicKey: owner.signingPublicKey, revision: 0, digest: null };
    try { await verifyPrivateWorkspaceDirectory(signed, scope, trust); }
    catch { throw new TRPCError({ code: "FORBIDDEN", message: "Workspace keys need the previously trusted owner's signature and consecutive history." }); }
    await PrivateDirectory.create({ workspaceId: scope.workspaceId, revision: directory.revision, digest, signerPublicKey: trust.signingPublicKey, signed });
    return { revision: directory.revision, digest };
  });
}
/** Immutable bounded history. The client still verifies its independently
 * pinned owner key; this transport is never a source of initial key trust. */
export async function privateDirectoryPage(workspaceId: string, userId: string, after: number, through?: number) {
  if (!Number.isSafeInteger(after) || after < 0 || (through !== undefined && (!Number.isSafeInteger(through) || through < after))) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const latest = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
  const bound = through ?? latest?.revision ?? 0;
  if (bound > (latest?.revision ?? 0) || after > bound) throw new TRPCError({ code: "CONFLICT", message: "Invalid workspace key checkpoint." });
  const rows = await PrivateDirectory.find({ workspaceId, revision: { $gt: after, $lte: bound } }).sort({ revision: 1 }).limit(10).lean();
  let expected = after + 1;
  for (const row of rows) if (row.revision !== expected++) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace key history is incomplete." });
  if (!rows.length && after < bound) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace key history is incomplete." });
  const last = rows.at(-1)?.revision ?? after;
  return { through: bound, next: last < bound ? last : null, directories: rows.map((row) => ({ digest: row.digest, signed: row.signed })) };
}
