import { TRPCError } from "@trpc/server";
import { canonicalJson } from "@starter/core";
import { PRIVATE_DEVICE_TTL_MS, type PrivateDeviceApproval, type PrivateDeviceInvite } from "@starter/shared";
import { PrivateAccount, PrivateDeviceRequest } from "../../models/PrivateData.js";
import { supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";

/** The relay stores only a public receiving key and an encrypted response.
 * Authentication alone cannot make the receiver accept a substituted key:
 * its locally generated key and browser confirmation code are also required. */
export async function createPrivateDeviceRequest(userId: string, requestId: string, publicKey: PrivateDeviceInvite["publicKey"]): Promise<{ expiresAt: string }> {
  if (Buffer.byteLength(JSON.stringify(publicKey)) > 2048) throw new TRPCError({ code: "BAD_REQUEST", message: "Device public key metadata is too large." });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private-device requests require a MongoDB replica set." });
  return withBusinessTransaction(async () => {
    // Contend on this account before counting, so concurrent requests cannot
    // bypass the bound. This counter is separate from signed identity revisions.
    if (!await PrivateAccount.findOneAndUpdate({ userId }, { $inc: { deviceSerial: 1 } }).lean()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set up private data keys first." });
    const current = await PrivateDeviceRequest.findOne({ _id: requestId, userId }).lean();
    const now = new Date();
    if (current) {
      if (current.expiresAt <= now) throw new TRPCError({ code: "NOT_FOUND" });
      if (canonicalJson(current.publicKey) !== canonicalJson(publicKey)) throw new TRPCError({ code: "CONFLICT" });
      return { expiresAt: current.expiresAt.toISOString() };
    }
    await PrivateDeviceRequest.deleteMany({ userId, expiresAt: { $lte: now } });
    if (await PrivateDeviceRequest.countDocuments({ userId, expiresAt: { $gt: now } }) >= 3) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Cancel an existing private-device request or wait for it to expire." });
    const expiresAt = new Date(now.getTime() + PRIVATE_DEVICE_TTL_MS);
    try { await PrivateDeviceRequest.create({ _id: requestId, userId, publicKey, expiresAt }); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw new TRPCError({ code: "CONFLICT" });
      throw error;
    }
    return { expiresAt: expiresAt.toISOString() };
  });
}
export async function privateDeviceStatus(userId: string, requestId: string) {
  const row = await PrivateDeviceRequest.findOne({ _id: requestId, userId, expiresAt: { $gt: new Date() } }).lean();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return { publicKey: row.publicKey, box: row.box, expiresAt: row.expiresAt.toISOString() };
}
export async function approvePrivateDevice(userId: string, requestId: string, box: PrivateDeviceApproval): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(box)) > 20_480) throw new TRPCError({ code: "BAD_REQUEST", message: "Encrypted device response is too large." });
  const row = await PrivateDeviceRequest.findOneAndUpdate({ _id: requestId, userId, expiresAt: { $gt: new Date() }, box: null }, { $set: { box } }, { returnDocument: "after" }).lean();
  if (row) return;
  const existing = await PrivateDeviceRequest.findOne({ _id: requestId, userId, expiresAt: { $gt: new Date() } }).lean();
  if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
  if (canonicalJson(existing.box) !== canonicalJson(box)) throw new TRPCError({ code: "CONFLICT", message: "This device already received a response. Start a new request in the app if its code was lost." });
}
export async function cancelPrivateDevice(userId: string, requestId: string): Promise<void> {
  await PrivateDeviceRequest.deleteOne({ _id: requestId, userId });
}
