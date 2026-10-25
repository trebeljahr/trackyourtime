import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import { PrivateAccountErasureFence } from "../../models/PrivateAccountErasureFence.js";
import { transactionSession, withBusinessTransaction } from "../business-transaction.js";
function id(userId: string) {
  if (typeof userId !== "string" || !userId || userId.length > 100) throw new TRPCError({ code: "UNAUTHORIZED" });
  return createHash("sha256").update(JSON.stringify(["trackyourtime-account-erasure-fence-v1", userId])).digest("hex");
}
/** Root/private writes hold this document until commit. Once deletion marks it,
 * a delayed request with an already-resolved session cannot recreate old keys.
 * Concurrent first inserts retry exactly like the workspace write fence. */
export async function fencePrivateAccount(userId: string): Promise<void> {
  if (!transactionSession()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private account writes require MongoDB transactions." });
  try {
    const row = await PrivateAccountErasureFence.findOneAndUpdate({ _id: id(userId) }, { $inc: { serial: 1 }, $setOnInsert: { erased: false } }, { upsert: true, returnDocument: "after" }).lean();
    if (!row || row.erased) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account erasure has started. Private writes are refused." });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) error.addErrorLabel("TransientTransactionError");
    throw error;
  }
}
/** Called only after the deletion endpoint verified its password/fresh-session
 * policy, before any cascade. The irreversible marker is separate from keys and
 * survives both cleanup passes. Standard deletion also works on standalone DBs. */
export function beginPrivateAccountErasure(userId: string): Promise<void> {
  const accountId = id(userId);
  return withBusinessTransaction(async () => {
    try { await PrivateAccountErasureFence.updateOne({ _id: accountId }, { $set: { erased: true }, $inc: { serial: 1 } }, { upsert: true }); }
    catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
        if (transactionSession()) { error.addErrorLabel("TransientTransactionError"); throw error; }
        // A standalone first-write race needs no multi-document transaction.
        await PrivateAccountErasureFence.updateOne({ _id: accountId }, { $set: { erased: true }, $inc: { serial: 1 } });
        return;
      }
      throw error;
    }
  });
}
