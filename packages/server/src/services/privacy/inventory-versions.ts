import { BSON, ObjectId } from "mongodb";
import { TRPCError } from "@trpc/server";
import { authenticatePrivateInventoryVersion, privateInventoryVersionRoot, type PublicKey } from "@starter/core";
import { signedPrivateInventoryVersionSchema, type SignedPrivateInventoryVersion } from "@starter/shared";
import { PrivateAccount } from "../../models/PrivateData.js";
import { PrivateInventoryVersion } from "../../models/PrivateInventoryVersion.js";
import { supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
export const PRIVATE_INVENTORY_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
export const PRIVATE_INVENTORY_HISTORY_MAX_VERSIONS = 4096;
type Scope = { server: string; userId: string };
const broken = () => new TRPCError({ code: "PRECONDITION_FAILED", message: "Account inventory history is incomplete or inconsistent. Stored data was kept for recovery." });
function validScope(scope: Scope) {
  const origin = new URL(scope.server);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== scope.server || !scope.userId || scope.userId.length > 100) throw new TRPCError({ code: "BAD_REQUEST" });
}
async function account(scope: Scope) {
  await fencePrivateAccount(scope.userId);
  const row = await PrivateAccount.findOneAndUpdate({ userId: scope.userId }, { $inc: { keySerial: 1 } }, { returnDocument: "after" }).lean();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  const revision = row.inventoryRevision ?? 0, root = row.inventoryRoot ?? null, bytes = row.inventoryBytes ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > PRIVATE_INVENTORY_HISTORY_MAX_VERSIONS || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > PRIVATE_INVENTORY_HISTORY_MAX_BYTES || (revision === 0 ? root !== null || bytes !== 0 : typeof root !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(root) || bytes === 0)) throw broken();
  const [stats] = await PrivateInventoryVersion.aggregate<{ count: number; bytes: number; first: number; last: number }>([
    { $match: { userId: scope.userId } }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$bytes" }, first: { $min: "$revision" }, last: { $max: "$revision" } } },
  ]);
  if ((stats?.count ?? 0) !== revision || (stats?.bytes ?? 0) !== bytes || (revision > 0 && (stats?.first !== 1 || stats?.last !== revision))) throw broken();
  const current = revision === 0 ? null : await PrivateInventoryVersion.findOne({ userId: scope.userId, revision }).lean();
  if (revision > 0 && (!current || current.root !== root || await privateInventoryVersionRoot(current.signed) !== root || current.signed.header.userId !== scope.userId || current.signed.header.server !== scope.server || current.signed.header.revision !== revision)) throw broken();
  if (current) {
    try { await authenticate(scope, current.signed, { revision: revision - 1, root: current.signed.header.previousRoot }, row.identity.signingPublicKey); }
    catch { throw broken(); }
  }
  return { row, checkpoint: { revision, root }, bytes };
}
async function authenticate(scope: Scope, signed: SignedPrivateInventoryVersion, previous: { revision: number; root: string | null }, key: PublicKey) {
  try { return await authenticatePrivateInventoryVersion({ scope, signed, previous, signingPublicKey: key, current: () => true }); }
  catch { throw new TRPCError({ code: "FORBIDDEN", message: "Account inventory ciphertext signature or key did not match." }); }
}
/** Internal persistence until its versioned account transport is mounted. The
 * server has no decryption key and never normalizes or replaces ciphertext.
 * Lost-response retries preserve the first accepted envelope/signature. */
export async function commitPrivateInventoryVersion(inputScope: Scope, input: SignedPrivateInventoryVersion) {
  const scope = { ...inputScope }, signed = signedPrivateInventoryVersionSchema.parse(input); validScope(scope);
  if (signed.header.server !== scope.server || signed.header.userId !== scope.userId) throw new TRPCError({ code: "NOT_FOUND" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account inventory history requires MongoDB transactions." });
  return withBusinessTransaction(async () => {
    const current = await account(scope), { header } = signed;
    const prior = await PrivateInventoryVersion.findOne({ userId: scope.userId, operationId: header.operationId }).lean();
    if (prior) {
      const checked = await authenticate(scope, signed, { revision: header.revision - 1, root: header.previousRoot }, current.row.identity.signingPublicKey);
      if (prior.revision !== header.revision || prior.root !== checked.checkpoint.root || prior.revision > current.checkpoint.revision || await privateInventoryVersionRoot(prior.signed) !== prior.root) throw new TRPCError({ code: "CONFLICT", message: "This inventory operation ID already names different ciphertext." });
      try { await authenticate(scope, prior.signed, { revision: prior.revision - 1, root: prior.signed.header.previousRoot }, current.row.identity.signingPublicKey); }
      catch { throw broken(); }
      return { revision: prior.revision, root: prior.root };
    }
    if (header.revision !== current.checkpoint.revision + 1 || header.previousRoot !== current.checkpoint.root) throw new TRPCError({ code: "CONFLICT", message: "Account inventory changed. The pending version must be kept for review." });
    const checked = await authenticate(scope, signed, current.checkpoint, current.row.identity.signingPublicKey);
    const now = new Date(), prototype = { _id: new ObjectId(), userId: scope.userId, revision: header.revision, operationId: header.operationId, root: checked.checkpoint.root, signed, bytes: 0, createdAt: now, updatedAt: now, __v: 0 };
    const bytes = Math.max(4096, BSON.calculateObjectSize(prototype) + 1024);
    if (header.revision > PRIVATE_INVENTORY_HISTORY_MAX_VERSIONS || current.bytes + bytes > PRIVATE_INVENTORY_HISTORY_MAX_BYTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account inventory history reached its metadata budget. Existing history and pending work were kept." });
    await PrivateInventoryVersion.create({ ...prototype, bytes });
    const saved = await PrivateAccount.updateOne({ _id: current.row._id, inventoryRevision: current.row.inventoryRevision === undefined ? { $exists: false } : current.checkpoint.revision }, { $set: { inventoryRevision: header.revision, inventoryRoot: checked.checkpoint.root, inventoryBytes: current.bytes + bytes } });
    if (saved.matchedCount !== 1) throw new TRPCError({ code: "CONFLICT" });
    return checked.checkpoint;
  });
}
/** Bounded immutable ciphertext pages, not an enrollment or standard-mode
 * fallback. A caller must authenticate every version against its trusted local
 * checkpoint and restore new devices through independent trust. */
export async function privateInventoryVersions(inputScope: Scope, after: number, through?: number) {
  const scope = { ...inputScope }; validScope(scope);
  if (!Number.isSafeInteger(after) || after < 0 || after > PRIVATE_INVENTORY_HISTORY_MAX_VERSIONS || (through !== undefined && (!Number.isSafeInteger(through) || through < after || through > PRIVATE_INVENTORY_HISTORY_MAX_VERSIONS))) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const current = await account(scope), end = through ?? current.checkpoint.revision;
    if (after > end || end > current.checkpoint.revision) throw new TRPCError({ code: "CONFLICT", message: "Account inventory history moved backward. Local data was kept." });
    const at = async (revision: number) => {
      if (revision === 0) return null;
      const row = await PrivateInventoryVersion.findOne({ userId: scope.userId, revision }).lean();
      if (!row || row.revision !== row.signed.header.revision || row.operationId !== row.signed.header.operationId || row.signed.header.userId !== scope.userId || row.signed.header.server !== scope.server || await privateInventoryVersionRoot(row.signed) !== row.root) throw broken();
      return row.root;
    };
    const root = await at(end); let previous = { revision: after, root: await at(after) };
    const rows = await PrivateInventoryVersion.find({ userId: scope.userId, revision: { $gt: after, $lte: end } }).sort({ revision: 1 }).limit(4).lean();
    const versions: SignedPrivateInventoryVersion[] = [];
    for (const row of rows) {
      if (row.revision !== previous.revision + 1) throw broken();
      const checked = await authenticate(scope, signedPrivateInventoryVersionSchema.parse(row.signed), previous, current.row.identity.signingPublicKey);
      if (checked.checkpoint.root !== row.root) throw broken();
      versions.push(checked.signed); previous = checked.checkpoint;
    }
    if (after < end && !versions.length) throw broken();
    if (previous.revision === end && previous.root !== root) throw broken();
    return { through: end, root, next: previous.revision < end ? previous.revision : null, versions };
  });
}
