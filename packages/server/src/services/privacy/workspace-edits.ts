import { TRPCError } from "@trpc/server";
import { canonicalJson, privateWorkspaceManifest, privateWorkspaceManifestForReader } from "@starter/core";
import { signedPrivateWorkspaceEditSchema, type SignedPrivateWorkspaceEdit, type PrivateWorkspaceChange } from "@starter/shared";
import { PrivateAccount, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { canWritePrivate, privateReaders } from "./access.js";
import { verifyPrivateChange } from "./signatures.js";

/** Internal engine. Public routes must keep the rollout guard until migration,
 * key-directory verification and every client path are complete. */
export async function commitPrivateWorkspaceEdit(userId: string, input: SignedPrivateWorkspaceEdit): Promise<{ revision: number }> {
  const { edit, signature, readerSignatures } = signedPrivateWorkspaceEditSchema.parse(input);
  if (edit.userId !== userId) throw new TRPCError({ code: "FORBIDDEN" });
  let manifest;
  try { manifest = await privateWorkspaceManifest(edit); }
  catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid private workspace edit." }); }
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Encrypted workspace edits require a MongoDB replica set." });
  return withBusinessTransaction(async () => {
    await fenceWorkspace(edit.workspaceId);
    const members = await WorkspaceMember.find({ workspaceId: edit.workspaceId }).lean();
    const actor = members.find((row) => row.userId === userId);
    if (!actor) throw new TRPCError({ code: "NOT_FOUND" });
    const prior = await PrivateWorkspaceCommit.findOne({ workspaceId: edit.workspaceId, userId, operationId: edit.operationId }).lean();
    if (prior) {
      if (canonicalJson(prior.manifest) !== canonicalJson(manifest)) throw new TRPCError({ code: "CONFLICT", message: "This operation ID was already used for a different edit." });
      return { revision: prior.revision };
    }
    const account = await PrivateAccount.findOne({ userId }).lean();
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    await verifyPrivateChange(account.identity.signingPublicKey, manifest, signature);
    const audience = readerSignatures.map((row) => row.userId);
    if (new Set(audience).size !== audience.length || canonicalJson([...audience].sort()) !== canonicalJson(members.map((row) => row.userId).sort())) throw new TRPCError({ code: "BAD_REQUEST", message: "Every workspace member needs a signed feed projection." });
    for (const reader of readerSignatures) await verifyPrivateChange(account.identity.signingPublicKey, privateWorkspaceManifestForReader(manifest, reader.userId), reader.signature);
    const mode = await PrivateWorkspace.findOne({ workspaceId: edit.workspaceId, state: "encrypted", revision: edit.expectedRevision });
    if (!mode) throw new TRPCError({ code: "CONFLICT", message: "Workspace changed. Reload before saving." });
    const revision = edit.expectedRevision + 1;
    const removed = new Set(edit.remove.map((row) => JSON.stringify([row.kind, row.id])));
    for (const row of [...manifest.records, ...manifest.remove]) {
      if (!canWritePrivate(row.kind, row.authorId, actor)) throw new TRPCError({ code: "FORBIDDEN" });
      if (canonicalJson(row.readers) !== canonicalJson(privateReaders(row.kind, row.authorId, members))) throw new TRPCError({ code: "BAD_REQUEST", message: "Encrypted recipients do not match workspace permissions." });
      const existing = await PrivateRecord.findOne({ workspaceId: edit.workspaceId, kind: row.kind, id: row.id }).lean();
      if (existing && existing.authorId !== row.authorId) throw new TRPCError({ code: "FORBIDDEN" });
      if (removed.has(JSON.stringify([row.kind, row.id])) && (!existing || existing.deleted)) throw new TRPCError({ code: "CONFLICT", message: "This record was already removed." });
    }
    for (const record of edit.records) await PrivateRecord.updateOne({ workspaceId: edit.workspaceId, kind: record.kind, id: record.id }, { $set: { ...record, deleted: false } }, { upsert: true });
    // Preserve the previous ciphertext revision: its authenticated encryption
    // context must never be rewritten merely to mark a row deleted.
    for (const row of edit.remove) await PrivateRecord.updateOne({ workspaceId: edit.workspaceId, kind: row.kind, id: row.id }, { $set: { deleted: true } });
    await PrivateWorkspaceCommit.create({ workspaceId: edit.workspaceId, userId, operationId: edit.operationId, revision, manifest, signature, readerSignatures, records: edit.records });
    mode.revision = revision; await mode.save();
    return { revision };
  });
}

/** Pagination is over immutable journal revisions and fixes an upper bound on
 * page one. Concurrent edits cannot move or replace rows on later pages. */
export async function privateWorkspaceChanges(workspaceId: string, userId: string, after: number, through?: number, limit = 20): Promise<{ through: number; next: number | null; changes: PrivateWorkspaceChange[] }> {
  if (!Number.isSafeInteger(after) || after < 0 || (through !== undefined && (!Number.isSafeInteger(through) || through < after)) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const mode = await PrivateWorkspace.findOne({ workspaceId, state: "encrypted" }).lean();
  if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  const bound = through ?? mode.revision;
  if (bound > mode.revision || after > bound) throw new TRPCError({ code: "CONFLICT", message: "Invalid private workspace checkpoint." });
  const changes: PrivateWorkspaceChange[] = [];
  let bytes = 0;
  const cursor = PrivateWorkspaceCommit.find({ workspaceId, revision: { $gt: after, $lte: bound } }).sort({ revision: 1 }).limit(limit).lean().cursor({ batchSize: 1 });
  try {
    for await (const row of cursor) {
      const readerSignature = row.readerSignatures.find((reader) => reader.userId === userId)?.signature;
      if (!readerSignature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This member needs a verified workspace snapshot before syncing." });
      const change = { revision: row.revision, manifest: privateWorkspaceManifestForReader(row.manifest, userId), signature: readerSignature, records: row.records.filter((record) => record.grants.some((grant) => grant.userId === userId)) };
      const size = Buffer.byteLength(JSON.stringify(change));
      if (changes.length && bytes + size > 8 * 1024 * 1024) break;
      changes.push(change); bytes += size;
    }
  } finally { await cursor.close(); }
  let expected = after + 1;
  for (const row of changes) if (row.revision !== expected++) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private workspace journal is incomplete." });
  if (!changes.length && after < bound) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private workspace journal is incomplete." });
  const last = changes.at(-1)?.revision ?? after;
  return { through: bound, next: last < bound ? last : null, changes };
}
