import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { canonicalJson, partitionPrivateRecovery, partitionPrivateRecoverySupplement, privateRecordDigest } from "@starter/core";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_USER_ONLY_KINDS, type EncryptedRecord } from "@starter/shared";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { privateReaders } from "./access.js";
import { requireActivePrivatePreparation } from "./preparation.js";
import { workspaceRecovery } from "./recovery.js";
import { capturePrivateMigrationSupplement } from "./recovery-supplement.js";
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
export const isPersonalPrivateKind = (kind: string) => (PRIVATE_USER_ONLY_KINDS as readonly string[]).includes(kind);
export type ProjectionPreparationScope = { server: string; workspaceId: string; migrationId: string; userId: string };

/** Server-internal complete ciphertext capture. Never return this object from
 * a user API: it includes other creators' opaque record IDs/ciphertext. Source
 * values and complete plaintext-source hashes never leave this function. */
export async function captureCompleteProjectionPreparation(scope: ProjectionPreparationScope) {
  scope = { ...scope };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { workspaceId, userId, migrationId, server } = scope;
    await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId, role: "owner" })) throw new TRPCError({ code: "FORBIDDEN" });
    const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, ownerId: userId }).lean();
    if (!mode?.supplementRevision) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    requireActivePrivatePreparation(mode);
    const directory = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
    if (!directory || directory.signed.directory.server !== server || directory.signed.directory.ownerId !== userId || (mode.directoryDigest && mode.directoryDigest !== directory.digest)) throw new TRPCError({ code: "CONFLICT" });
    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const permissions = (rows: readonly { userId: string; role: string; canViewOthersTime?: boolean; canViewOthersMoney?: boolean }[]) => [...rows].sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0).map((m) => ({ userId: m.userId, role: m.role, canViewOthersTime: m.role === "owner" || !!m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || !!m.canViewOthersMoney }));
    if (canonicalJson(permissions(members)) !== canonicalJson(permissions(directory.signed.directory.members))) throw new TRPCError({ code: "CONFLICT", message: "Workspace sharing changed. Source data was kept." });
    const accounts = await PrivateAccount.find({ userId: { $in: members.map((member) => member.userId) } }).select({ userId: 1, "identity.publicKey": 1, "identity.signingPublicKey": 1 }).lean();
    const coordinates = ({ kty, crv, x, y }: typeof directory.signed.directory.members[number]["publicKey"]) => ({ kty, crv, x, y });
    for (const member of directory.signed.directory.members) {
      const account = accounts.find((row) => row.userId === member.userId);
      if (!account?.identity?.publicKey || !account.identity.signingPublicKey || canonicalJson(coordinates(account.identity.publicKey)) !== canonicalJson(coordinates(member.publicKey)) || canonicalJson(coordinates(account.identity.signingPublicKey)) !== canonicalJson(coordinates(member.signingPublicKey))) throw new TRPCError({ code: "CONFLICT", message: "Workspace account keys changed. Verify the directory again." });
    }
    const source = await workspaceRecovery(workspaceId, userId, true), supplement = await capturePrivateMigrationSupplement(workspaceId, userId);
    if (source.sourceRevision !== mode.sourceRevision || supplement.sourceRevision !== mode.supplementRevision) throw new TRPCError({ code: "CONFLICT", message: "Original data changed. Source data was kept." });
    const originals = [...partitionPrivateRecovery(source), ...partitionPrivateRecoverySupplement(supplement)];
    const records: EncryptedRecord[] = []; let bytes = 2;
    const cursor = PrivateRecord.find({ workspaceId }).lean().cursor({ batchSize: 10 });
    try {
      for await (const row of cursor) {
        const record = encryptedRecordSchema.parse({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, keyCommitment: row.keyCommitment, box: row.box, grants: row.grants });
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (records.length >= 400_000 || bytes > PRIVATE_SNAPSHOT_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
        const audience = record.grants.map((grant) => grant.userId).sort();
        if (row.deleted || record.revision !== 1 || !record.keyCommitment || new Set(audience).size !== audience.length || canonicalJson(audience) !== canonicalJson(privateReaders(record.kind, record.authorId, members))) throw new TRPCError({ code: "CONFLICT", message: "Staged ciphertext revision, key binding or audience changed." });
        records.push(record);
      }
    } finally { await cursor.close(); }
    records.sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
    const addresses = (rows: readonly { kind: string; id: string; authorId: string | null }[]) => rows.map((row) => JSON.stringify([row.kind, row.id, row.authorId])).sort();
    if (canonicalJson(addresses(records)) !== canonicalJson(addresses(originals))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Staged ciphertext is incomplete. Original data was kept." });
    return { records, directory, fullRecordsDigest: createHash("sha256").update(canonicalJson(records)).digest("hex") };
  });
}
/** Internal owner proposal only: full shared grants plus own personal records,
 * and opaque personal digests for peers. No plaintext, other identities' root
 * wrappers, complete source checksum or foreign private IDs/counts are returned.
 * This neither freezes the proposal nor enables conversion. */
export async function privateProjectionProposal(scope: ProjectionPreparationScope) {
  scope = { ...scope };
  const captured = await captureCompleteProjectionPreparation(scope);
  const sharedRecords = captured.records.filter((row) => !isPersonalPrivateKind(row.kind));
  const ownerPersonalRecords = captured.records.filter((row) => isPersonalPrivateKind(row.kind) && row.authorId === scope.userId);
  const personalDigests = [];
  for (const member of captured.directory.signed.directory.members) personalDigests.push({ userId: member.userId, digest: await privateRecordDigest(captured.records.filter((row) => isPersonalPrivateKind(row.kind) && row.authorId === member.userId)) });
  return { migrationId: scope.migrationId, directoryDigest: captured.directory.digest, sharedRecords, ownerPersonalRecords, personalDigests };
}
