import { recoveryDigest } from "@starter/core";
import mongoose from "mongoose";
import { BSON } from "mongodb";
import { TRPCError } from "@trpc/server";
import { supportsBusinessTransactions, transactionSession, withBusinessTransaction } from "../business-transaction.js";
import { RECOVERY_KINDS, RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, type WorkspaceRecovery } from "@starter/shared";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";

/** Lossless, installation-bound recovery data. Unlike a portable export it
 * preserves IDs, invoice/entry links, issued XML, approvals, and import data. */
export async function workspaceRecovery(workspaceId: string, ownerId: string, includeOtherPreferences = false): Promise<WorkspaceRecovery> {
  if (!transactionSession()) {
    if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Consistent recovery backups require a MongoDB replica set." });
    return withBusinessTransaction(() => workspaceRecovery(workspaceId, ownerId, includeOtherPreferences));
  }
  const owner = await WorkspaceMember.findOne({ workspaceId, userId: ownerId, role: "owner" }).lean();
  if (!owner) throw new TRPCError({ code: "FORBIDDEN" });
  const db = mongoose.connection.db;
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const collections = {} as WorkspaceRecovery["collections"];
  let bytes = 1024, count = 0;
  // Sequential to stay valid inside Mongo transaction sessions.
  for (const kind of RECOVERY_KINDS) {
    const cursor = db.collection(kind).find({ workspaceId, ...(kind === "favorites" && !includeOtherPreferences ? { userId: ownerId } : {}) }, { session: transactionSession(), promoteValues: false, promoteLongs: false }).sort({ _id: 1 });
    collections[kind] = [];
    try {
      for await (const row of cursor) {
        const typed = BSON.EJSON.serialize(row, { relaxed: false }) as Record<string, unknown>;
        bytes += Buffer.byteLength(JSON.stringify(typed), "utf8") + 1; count++;
        if (bytes > RECOVERY_MAX_BYTES || count > RECOVERY_MAX_RECORDS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "This workspace exceeds the supported recovery backup size. Source data was kept." });
        collections[kind].push(typed);
      }
    } finally { await cursor.close(); }
  }
  const sourceRevision = await recoveryDigest(collections);
  return { v: 1, workspaceId, createdAt: new Date().toISOString(), sourceRevision, collections };
}
