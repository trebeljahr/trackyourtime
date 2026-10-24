import { TRPCError } from "@trpc/server";
import { canonicalJson, privateRecordDigest, privateWorkspaceChainRoot, privateWorkspaceManifest, privateWorkspaceManifestForReader } from "@starter/core";
import { signedPrivateChainedEditSchema, signedPrivateWorkspaceEditSchema, type SignedPrivateWorkspaceEdit, type PrivateWorkspaceChange, type PrivateWorkspaceChain, type SignedPrivateChainedEdit, type PrivateChainedWorkspaceChange } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { canWritePrivate, privateReaders } from "./access.js";
import { verifyPrivateChange } from "./signatures.js";

/** Internal engine. Public routes must keep the rollout guard until migration,
 * key-directory verification and every client path are complete. */
export async function commitPrivateWorkspaceEdit(userId: string, input: SignedPrivateWorkspaceEdit): Promise<{ revision: number }> {
  return commitWorkspaceEdit(userId, input);
}
export async function commitPrivateChainedWorkspaceEdit(userId: string, input: SignedPrivateChainedEdit, server: string): Promise<{ revision: number; head: string }> {
  const { chain, ...signed } = signedPrivateChainedEditSchema.parse(input);
  const receipt = await commitWorkspaceEdit(userId, signed, chain, server);
  if (!receipt.head) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A chained history receipt is required." });
  return { revision: receipt.revision, head: receipt.head };
}
async function commitWorkspaceEdit(userId: string, input: SignedPrivateWorkspaceEdit, chain?: PrivateWorkspaceChain, server?: string): Promise<{ revision: number; head?: string }> {
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
      if (!!prior.chain !== !!chain || (chain && canonicalJson(prior.chain?.header) !== canonicalJson(chain.header))) throw new TRPCError({ code: "CONFLICT", message: "This operation ID belongs to another history binding." });
      if (chain) {
        const directory = await PrivateDirectory.findOne({ workspaceId: edit.workspaceId, digest: chain.header.directoryDigest }).lean();
        const signer = directory?.signed.directory.members.find((member) => member.userId === userId);
        if (!signer || directory?.signed.directory.server !== server) throw new TRPCError({ code: "PRECONDITION_FAILED" });
        await verifyPrivateChange(signer.signingPublicKey, chain.header, chain.signature);
        if (!prior.head || prior.head !== await privateWorkspaceChainRoot(chain)) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      }
      return { revision: prior.revision, ...(prior.head ? { head: prior.head } : {}) };
    }
    const account = await PrivateAccount.findOne({ userId }).lean();
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    await verifyPrivateChange(account.identity.signingPublicKey, manifest, signature);
    const audience = readerSignatures.map((row) => row.userId);
    if (new Set(audience).size !== audience.length || canonicalJson([...audience].sort()) !== canonicalJson(members.map((row) => row.userId).sort())) throw new TRPCError({ code: "BAD_REQUEST", message: "Every workspace member needs a signed feed projection." });
    for (const reader of readerSignatures) await verifyPrivateChange(account.identity.signingPublicKey, privateWorkspaceManifestForReader(manifest, reader.userId), reader.signature);
    const mode = await PrivateWorkspace.findOne({ workspaceId: edit.workspaceId, state: "encrypted", revision: edit.expectedRevision });
    if (!mode) throw new TRPCError({ code: "CONFLICT", message: "Workspace changed. Reload before saving." });
    let head: string | null = null;
    if (mode.head || mode.directoryDigest || chain) {
      if (!mode.head || !mode.directoryDigest || !chain) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workspace requires a verified snapshot and chained writes." });
      if (chain.header.previousRoot !== mode.head || chain.header.directoryDigest !== mode.directoryDigest) throw new TRPCError({ code: "CONFLICT", message: "Workspace history changed. Keep your pending edit for review." });
      const directory = await PrivateDirectory.findOne({ workspaceId: edit.workspaceId, digest: mode.directoryDigest }).lean();
      if (!directory || directory.signed.directory.server !== server) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      const permissions = (rows: readonly { userId: string; role: string; canViewOthersTime: boolean; canViewOthersMoney: boolean }[]) => [...rows].sort((a, b) => a.userId < b.userId ? -1 : 1).map((m) => ({ userId: m.userId, role: m.role, canViewOthersTime: m.role === "owner" || m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || m.canViewOthersMoney }));
      if (canonicalJson(permissions(members)) !== canonicalJson(permissions(directory.signed.directory.members))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sharing changes require a verified directory transition." });
      const signer = directory.signed.directory.members.find((member) => member.userId === userId);
      const coordinates = ({ kty, crv, x, y }: typeof account.identity.signingPublicKey) => ({ kty, crv, x, y });
      if (!signer || canonicalJson(coordinates(signer.signingPublicKey)) !== canonicalJson(coordinates(account.identity.signingPublicKey))) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      const readers = [];
      for (const member of directory.signed.directory.members) readers.push({ userId: member.userId, digest: await privateRecordDigest(privateWorkspaceManifestForReader(manifest, member.userId)) });
      const expected = { v: 1, protocol: "trackyourtime-private-workspace-chain-v1", server, workspaceId: edit.workspaceId, userId, operationId: edit.operationId, expectedRevision: edit.expectedRevision, directoryDigest: mode.directoryDigest, previousRoot: mode.head, manifestDigest: await privateRecordDigest(manifest), readers };
      if (canonicalJson(expected) !== canonicalJson(chain.header)) throw new TRPCError({ code: "BAD_REQUEST", message: "Private history binding does not match the complete edit." });
      await verifyPrivateChange(signer.signingPublicKey, chain.header, chain.signature);
      head = await privateWorkspaceChainRoot(chain);
    }
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
    await PrivateWorkspaceCommit.create({ workspaceId: edit.workspaceId, userId, operationId: edit.operationId, revision, manifest, signature, readerSignatures, records: edit.records, chain: chain ?? null, head });
    mode.revision = revision; mode.head = head; await mode.save();
    return { revision, ...(head ? { head } : {}) };
  });
}

/** Pagination is over immutable journal revisions and fixes an upper bound on
 * page one. Concurrent edits cannot move or replace rows on later pages. */
export async function privateWorkspaceChanges(workspaceId: string, userId: string, after: number, through?: number, limit = 20): Promise<{ through: number; next: number | null; changes: PrivateWorkspaceChange[] }> {
  return workspaceChanges(workspaceId, userId, after, through, limit, false);
}
export async function privateChainedWorkspaceChanges(workspaceId: string, userId: string, after: number, through?: number, limit = 20): Promise<{ through: number; next: number | null; changes: PrivateChainedWorkspaceChange[] }> {
  return workspaceChanges(workspaceId, userId, after, through, limit, true) as Promise<{ through: number; next: number | null; changes: PrivateChainedWorkspaceChange[] }>;
}
async function workspaceChanges(workspaceId: string, userId: string, after: number, through: number | undefined, limit: number, chained: boolean): Promise<{ through: number; next: number | null; changes: (PrivateWorkspaceChange | PrivateChainedWorkspaceChange)[] }> {
  if (!Number.isSafeInteger(after) || after < 0 || (through !== undefined && (!Number.isSafeInteger(through) || through < after)) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await WorkspaceMember.exists({ workspaceId, userId })) throw new TRPCError({ code: "NOT_FOUND" });
  const mode = await PrivateWorkspace.findOne({ workspaceId, state: "encrypted" }).lean();
  if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  if (Boolean(mode.head) !== Boolean(mode.directoryDigest) || Boolean(mode.head) !== chained) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Use the history protocol bound to this workspace's initial snapshot." });
  const bound = through ?? mode.revision;
  if (bound > mode.revision || after > bound) throw new TRPCError({ code: "CONFLICT", message: "Invalid private workspace checkpoint." });
  const changes: (PrivateWorkspaceChange | PrivateChainedWorkspaceChange)[] = [];
  let bytes = 0;
  const cursor = PrivateWorkspaceCommit.find({ workspaceId, revision: { $gt: after, $lte: bound } }).sort({ revision: 1 }).limit(limit).lean().cursor({ batchSize: 1 });
  try {
    for await (const row of cursor) {
      const readerSignature = row.readerSignatures.find((reader) => reader.userId === userId)?.signature;
      if (!readerSignature) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This member needs a verified workspace snapshot before syncing." });
      if (chained && (!row.chain || !row.head || row.head !== await privateWorkspaceChainRoot(row.chain))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private history binding is incomplete." });
      const change = { revision: row.revision, manifest: privateWorkspaceManifestForReader(row.manifest, userId), signature: readerSignature, records: row.records.filter((record) => record.grants.some((grant) => grant.userId === userId)), ...(chained ? { chain: row.chain! } : {}) };
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
