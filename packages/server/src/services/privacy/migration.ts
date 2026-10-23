import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import { canonicalJson, encryptPrivateRecord, partitionPrivateRecovery, type PrivateRecipient } from "@starter/core";
import { RECOVERY_KINDS } from "@starter/shared";
import { PrivateAccount, PrivateRecord, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { workspaceRecovery } from "./recovery.js";
import { verifyPrivateChange } from "./signatures.js";
import { fenceWorkspace, supportsBusinessTransactions, transactionSession, withBusinessTransaction } from "../business-transaction.js";
/** Kept closed until encrypted clients, restore drills, and legacy-write
 * fencing have passed end-to-end validation. Never enable through an env var. */
export function requirePrivateWorkspaceRollout(): void {
  throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Encrypted workspace migration is not available in this build. Existing data is unchanged." });
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export async function privateMigrationAction(workspaceId: string, userId: string, action: unknown, signature: string): Promise<void> {
  requirePrivateWorkspaceRollout();
  if (!await WorkspaceMember.exists({ workspaceId, userId, role: "owner" })) throw new TRPCError({ code: "FORBIDDEN" });
  const account = await PrivateAccount.findOne({ userId }).lean();
  if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set up private data recovery first." });
  await verifyPrivateChange(account.identity.signingPublicKey, action, signature);
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Migration requires a replica set and verified database backups." });
}
export async function privateRecipients(workspaceId: string): Promise<PrivateRecipient[]> {
  const members = await WorkspaceMember.find({ workspaceId }).lean();
  const accounts = await PrivateAccount.find({ userId: { $in: members.map((m) => m.userId) } }).lean();
  return members.map((m) => {
    const account = accounts.find((a) => a.userId === m.userId);
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every member must set up private-data keys before migrating this workspace." });
    return { userId: m.userId, role: m.role, canViewOthersTime: m.canViewOthersTime, canViewOthersMoney: m.canViewOthersMoney, publicKey: account.identity.publicKey };
  });
}
export async function beginPrivateMigration(workspaceId: string, userId: string, sourceRevision: string, signature: string): Promise<{ migrationId: string }> {
  await privateMigrationAction(workspaceId, userId, { action: "begin-private-migration", workspaceId, userId, sourceRevision }, signature);
  return withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    if (await PrivateWorkspace.exists({ workspaceId })) throw new TRPCError({ code: "CONFLICT", message: "A migration already exists for this workspace." });
    await privateRecipients(workspaceId);
    const source = await workspaceRecovery(workspaceId, userId);
    if (source.sourceRevision !== sourceRevision) throw new TRPCError({ code: "CONFLICT", message: "Workspace changed. Make a fresh backup before migrating." });
    if (await mongoose.connection.db!.collection("timeentries").countDocuments({ workspaceId, end: null }, { session: transactionSession() })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stop all workspace timers before migrating." });
    const completeSource = await workspaceRecovery(workspaceId, userId, true);
    const migrationId = randomUUID();
    await PrivateWorkspace.create({ workspaceId, ownerId: userId, state: "migrating", revision: 0, migrationId, sourceRevision: completeSource.sourceRevision, leaseUntil: new Date(Date.now() + 3600000) });
    return { migrationId };
  });
}
export async function stagePrivateMigration(workspaceId: string, userId: string, migrationId: string, offset: number): Promise<{ next: number | null; total: number }> {
  requirePrivateWorkspaceRollout();
  const mode = await PrivateWorkspace.findOne({ workspaceId, state: "migrating", migrationId, ownerId: userId }).lean();
  if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
  const source = await workspaceRecovery(workspaceId, userId, true);
  const plain = partitionPrivateRecovery(source);
  const recipients = await privateRecipients(workspaceId);
  const end = Math.min(plain.length, offset + 50);
  for (const record of plain.slice(offset, end)) {
    // Retries preserve the same ciphertext, so a downloaded archive does not
    // silently become obsolete after a lost response.
    if (await PrivateRecord.exists({ workspaceId, kind: record.kind, id: record.id })) continue;
    const encrypted = await encryptPrivateRecord(workspaceId, record, recipients, 1);
    await PrivateRecord.create({ workspaceId, ...encrypted, deleted: false });
  }
  return { next: end >= plain.length ? null : end, total: plain.length };
}
export async function privateMigrationArchive(workspaceId: string, userId: string, migrationId: string) {
  const mode = await PrivateWorkspace.findOne({ workspaceId, migrationId, ownerId: userId }).lean();
  if (!mode) throw new TRPCError({ code: "NOT_FOUND" });
  const members = await WorkspaceMember.find({ workspaceId }).sort({ userId: 1 }).lean();
  const accounts = await PrivateAccount.find({ userId: { $in: members.map((m) => m.userId) } }).sort({ userId: 1 }).lean();
  const rows = await PrivateRecord.find({ workspaceId }).sort({ kind: 1, id: 1 }).lean();
  const archive = {
    format: "trackyourtime-private-workspace-v1" as const, workspaceId, migrationId,
    createdAt: String((mode as unknown as { createdAt: Date }).createdAt.toISOString()),
    sourceRevision: mode.sourceRevision,
    identities: accounts.map((a) => ({ userId: a.userId, identity: a.identity })),
    members: members.map((m) => ({ userId: m.userId, role: m.role, canViewOthersTime: m.canViewOthersTime, canViewOthersMoney: m.canViewOthersMoney })),
    records: rows.map((r) => ({ id: r.id, kind: r.kind, authorId: r.authorId, revision: r.revision, box: r.box, grants: r.grants, deleted: r.deleted })),
  };
  return { archive, hash: hash(archive) };
}
export async function commitPrivateMigration(workspaceId: string, userId: string, migrationId: string, backupHash: string, signature: string): Promise<void> {
  await privateMigrationAction(workspaceId, userId, { action: "commit-private-migration", workspaceId, userId, migrationId, backupHash }, signature);
  await withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId, state: "migrating", migrationId, ownerId: userId });
    if (!mode) throw new TRPCError({ code: "CONFLICT" });
    const { hash: actualHash } = await privateMigrationArchive(workspaceId, userId, migrationId);
    if (actualHash !== backupHash) throw new TRPCError({ code: "CONFLICT", message: "Reopen and verify the latest encrypted backup before continuing." });
    const source = await workspaceRecovery(workspaceId, userId, true);
    if (source.sourceRevision !== mode.sourceRevision) throw new TRPCError({ code: "CONFLICT", message: "Source data changed during migration. Cancel and retry; source data was kept." });
    const expected = partitionPrivateRecovery(source).map((r) => `${r.kind}:${r.id}:${r.authorId}`).sort();
    const stored = await PrivateRecord.find({ workspaceId }).lean();
    const actual = stored.map((r) => `${r.kind}:${r.id}:${r.authorId}`).sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Encrypted migration is incomplete. Source data was kept." });
    for (const kind of RECOVERY_KINDS) {
      if (kind === "workspacemembers") await mongoose.connection.db!.collection(kind).updateMany({ workspaceId }, { $set: { hourlyRate: null } }, { session: transactionSession() });
      else await mongoose.connection.db!.collection(kind).deleteMany({ workspaceId }, { session: transactionSession() });
    }
    // Retry receipts and queued webhook payloads must not retain plaintext.
    await mongoose.connection.db!.collection("webhookdeliveries").deleteMany({ workspaceId }, { session: transactionSession() });
    mode.state = "encrypted"; mode.revision = 1; mode.backupVerified = true; await mode.save();
  });
}
export async function cancelPrivateMigration(workspaceId: string, userId: string, migrationId: string, signature: string): Promise<void> {
  await privateMigrationAction(workspaceId, userId, { action: "cancel-private-migration", workspaceId, userId, migrationId }, signature);
  await withBusinessTransaction(async () => {
    await fenceWorkspace(workspaceId);
    const mode = await PrivateWorkspace.findOne({ workspaceId, ownerId: userId, state: "migrating", migrationId });
    if (!mode) throw new TRPCError({ code: "CONFLICT" });
    await PrivateRecord.deleteMany({ workspaceId }); await mode.deleteOne();
  });
}
