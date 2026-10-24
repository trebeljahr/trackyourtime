import mongoose from "mongoose";
import { BSON, ObjectId } from "mongodb";
import { TRPCError } from "@trpc/server";
import { assertSharedOrganizationSupplement, emptyRecoverySupplementCollections, recoverySupplementDigest, verifyWorkspaceRecoverySupplement } from "@starter/core";
import { RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, RECOVERY_SUPPLEMENT_KINDS, PRIVATE_WORKSPACE_REQUIRED, type WorkspaceRecoverySupplement } from "@starter/shared";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import { supportsBusinessTransactions, transactionSession, withBusinessTransaction } from "../business-transaction.js";
/** Internal source reader. A normal member/owner receives organization identity
 * and their own integration originals only. Complete-source capture is reserved
 * for the owner-controlled migration engine and never mounted as a user API.
 * Existing encrypted workspaces never fall back to an empty plaintext backup. */
export function workspaceRecoverySupplement(workspaceId: string, userId: string): Promise<WorkspaceRecoverySupplement> {
  return readSupplement(workspaceId, userId, false);
}
/** Server-side frozen-source capture only. Never return this value from a user
 * API: other creators' originals must be encrypted to their own keys in place. */
export function capturePrivateMigrationSupplement(workspaceId: string, ownerId: string): Promise<WorkspaceRecoverySupplement> {
  return readSupplement(workspaceId, ownerId, true);
}
async function readSupplement(workspaceId: string, userId: string, includeOtherPrivate: boolean): Promise<WorkspaceRecoverySupplement> {
  if (!transactionSession()) {
    if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    return withBusinessTransaction(() => readSupplement(workspaceId, userId, includeOtherPrivate));
  }
  const member = await WorkspaceMember.findOne({ workspaceId, userId }).lean();
  if (!member) throw new TRPCError({ code: "NOT_FOUND" });
  if (includeOtherPrivate && member.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
  if (await PrivateWorkspace.exists({ workspaceId, state: "encrypted" })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED });
  const db = mongoose.connection.db; if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const collections = emptyRecoverySupplementCollections();
  let bytes = 1024, count = 0;
  const ids: (string | ObjectId)[] = [workspaceId]; if (ObjectId.isValid(workspaceId)) ids.push(new ObjectId(workspaceId));
  for (const kind of RECOVERY_SUPPLEMENT_KINDS) {
    const filter = kind === "organization" ? { $or: [{ _id: { $in: ids } }, { id: workspaceId }] }
      : { workspaceId, ...(!includeOtherPrivate ? kind === "apitokens" ? { userId } : { createdBy: userId } : {}) };
    const cursor = db.collection<{ _id: string | ObjectId }>(kind).find(filter, { session: transactionSession(), promoteValues: false, promoteLongs: false }).sort({ _id: 1 });
    try {
      for await (const row of cursor) {
        const typed = BSON.EJSON.serialize(row, { relaxed: false }) as Record<string, unknown>;
        bytes += Buffer.byteLength(JSON.stringify(typed)) + 1; count++;
        if (bytes > RECOVERY_MAX_BYTES || count > RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Supplemental recovery exceeds its supported size. Source data was kept." });
        collections[kind].push(typed);
      }
    } finally { await cursor.close(); }
  }
  if (!includeOtherPrivate) for (const row of collections.organization) assertSharedOrganizationSupplement(row, workspaceId);
  return verifyWorkspaceRecoverySupplement({ v: 1, workspaceId, createdAt: new Date().toISOString(), sourceRevision: await recoverySupplementDigest(collections), collections }, workspaceId);
}
