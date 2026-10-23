import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { BSON } from "mongodb";
import { TRPCError } from "@trpc/server";
import { transactionSession } from "../business-transaction.js";
import { RECOVERY_KINDS, type WorkspaceRecovery } from "@starter/shared";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";

/** Lossless, installation-bound recovery data. Unlike a portable export it
 * preserves IDs, invoice/entry links, issued XML, approvals, and import data. */
export async function workspaceRecovery(workspaceId: string, ownerId: string, includeOtherPreferences = false): Promise<WorkspaceRecovery> {
  const owner = await WorkspaceMember.findOne({ workspaceId, userId: ownerId, role: "owner" }).lean();
  if (!owner) throw new TRPCError({ code: "FORBIDDEN" });
  const db = mongoose.connection.db;
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const collections = {} as WorkspaceRecovery["collections"];
  // Sequential to stay valid inside Mongo transaction sessions.
  for (const kind of RECOVERY_KINDS) {
    const rows = await db.collection(kind).find({ workspaceId, ...(kind === "favorites" && !includeOtherPreferences ? { userId: ownerId } : {}) }, { session: transactionSession() }).sort({ _id: 1 }).limit(200001).toArray();
    if (rows.length > 200000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "A migration recovery collection exceeds the supported record limit." });
    collections[kind] = BSON.EJSON.serialize(rows, { relaxed: false }) as unknown as Record<string, unknown>[];
  }
  const sourceRevision = createHash("sha256").update(JSON.stringify(collections)).digest("hex");
  return { v: 1, workspaceId, createdAt: new Date().toISOString(), sourceRevision, collections };
}
