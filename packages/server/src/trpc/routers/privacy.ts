import { commitPrivateDirectory, privateDirectoryPage } from "../../services/privacy/directories.js";
import { privateInitialSnapshotManifest, privateInitialSnapshotPage } from "../../services/privacy/initial-snapshots.js";
import { env } from "../../config/env.js";
import { signedPrivateDirectorySchema } from "@starter/shared";
import { getAuth } from "../../auth/auth.js";
import { previewAccountDeletion } from "../../services/account-deletion/delete-account.js";
import { authRowStore, mongooseRowStore, routedRowStore } from "../../services/account-deletion/stores.js";
import { commitPrivateWorkspaceEdit, privateWorkspaceChanges } from "../../services/privacy/workspace-edits.js";
import { signedPrivateWorkspaceEditSchema } from "@starter/shared";
import { requirePrivateWorkspaceRollout, beginPrivateMigration, stagePrivateMigration, privateMigrationArchive, commitPrivateMigration, cancelPrivateMigration } from "../../services/privacy/migration.js";
import { canonicalJson } from "@starter/core";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { encryptedRecordSchema, privateIdentitySchema, privateDeviceApprovalSchema, publicEncryptionKeySchema, type PrivateIdentity, type EncryptedRecord } from "@starter/shared";
import { approvePrivateDevice, cancelPrivateDevice, createPrivateDeviceRequest, privateDeviceStatus } from "../../services/privacy/devices.js";
import { PrivateAccount, PrivateDirectory, PrivateRecord, PrivateWorkspace } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { workspaceIdFromInput, resolveWorkspace } from "../../auth/workspace.js";
import { supportsBusinessTransactions, withBusinessTransaction, fenceWorkspace, transactionSession } from "../../services/business-transaction.js";
import { privateReaders, canWritePrivate } from "../../services/privacy/access.js";
import { verifyPrivateChange } from "../../services/privacy/signatures.js";
import { workspaceRecovery } from "../../services/privacy/recovery.js";
import { protectedProcedure, router } from "../trpc.js";
const scopeSchema = z.object({ workspaceId: z.string().min(1).max(100).optional() });
const privateAccountProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.res && !ctx.res.headersSent) ctx.res.setHeader("Cache-Control", "no-store");
  return next();
});
const privateWorkspaceProcedure = privateAccountProcedure.use(async ({ ctx, next, getRawInput }) => {
  const found = await resolveWorkspace({ user: ctx.user, requested: workspaceIdFromInput(await getRawInput()), activeWorkspaceId: ctx.activeWorkspaceId });
  if (!found) throw new TRPCError({ code: "NOT_FOUND" });
  return next({ ctx: { ...ctx, ...found } });
});
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
function privateServerOrigin(): string {
  try {
    const url = new URL(env.BETTER_AUTH_URL);
    if (["https:", "http:"].includes(url.protocol)) return url.origin;
  } catch { /* An unset public API origin cannot bind a private identity. */ }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Configure this server's public API origin before enrolling private keys." });
}
async function requireTransactions(): Promise<void> {
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Encryption migration requires a MongoDB replica set." });
}
function validateRecordAudience(record: EncryptedRecord, members: Awaited<ReturnType<typeof allMembers>>): void {
  const required = privateReaders(record.kind, record.authorId, members);
  const actual = record.grants.map((g) => g.userId).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(required)) throw new TRPCError({ code: "BAD_REQUEST", message: "Encrypted recipients do not match workspace permissions." });
}
const allMembers = (workspaceId: string) => WorkspaceMember.find({ workspaceId }).lean();
export const privacyRouter = router({
  deletionPreview: privateAccountProcedure.input(z.object({ userId: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    if (input.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
    const { adapter } = await getAuth().$context;
    return previewAccountDeletion(routedRowStore(mongooseRowStore, authRowStore(adapter)), ctx.user.id);
  }),
  identity: privateAccountProcedure.input(z.object({ userId: z.string().min(1).max(100).optional() }).optional()).query(async ({ ctx, input }) => {
    if (input?.userId && input.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
    const doc = await PrivateAccount.findOne({ userId: ctx.user.id }).lean();
    return doc ? { identity: doc.identity, revision: doc.revision } : null;
  }),
  enroll: privateAccountProcedure.input(z.object({ identity: privateIdentitySchema, userId: z.string().min(1).max(100).optional(), server: z.string().url().max(2048).optional() })).mutation(async ({ ctx, input }) => {
    if ((input.userId && input.userId !== ctx.user.id) || (input.server && input.server !== privateServerOrigin())) throw new TRPCError({ code: "NOT_FOUND" });
    // A retry may reuse the exact encrypted identity after a lost response.
    // Login/reset alone must never overwrite an existing identity.
    const current = await PrivateAccount.findOne({ userId: ctx.user.id }).lean();
    if (current) {
      if (canonicalJson(current.identity) === canonicalJson(input.identity)) return { revision: current.revision };
      throw new TRPCError({ code: "CONFLICT", message: "Private identity already exists. Unlock it before making changes." });
    }
    try { await PrivateAccount.create({ userId: ctx.user.id, identity: input.identity, revision: 1 }); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const raced = await PrivateAccount.findOne({ userId: ctx.user.id }).lean();
      if (raced && canonicalJson(raced.identity) === canonicalJson(input.identity)) return { revision: raced.revision };
      throw new TRPCError({ code: "CONFLICT" });
    }
    return { revision: 1 };
  }),
  updateIdentity: privateAccountProcedure.input(z.object({ identity: privateIdentitySchema, revision: z.number().int().positive(), signature: signatureSchema })).mutation(({ ctx, input }) => withBusinessTransaction(async () => {
    const current = await PrivateAccount.findOne({ userId: ctx.user.id }).lean();
    if (!current) throw new TRPCError({ code: "NOT_FOUND" });
    await verifyPrivateChange(current.identity.signingPublicKey, { userId: ctx.user.id, revision: input.revision, identity: input.identity }, input.signature);
    const coordinates = ({ kty, crv, x, y }: PrivateIdentity["publicKey"]) => ({ kty, crv, x, y });
    const keySet = (identity: PrivateIdentity) => canonicalJson([coordinates(identity.publicKey), coordinates(identity.signingPublicKey)]);
    if (keySet(current.identity) !== keySet(input.identity)) {
      const workspaces = await WorkspaceMember.distinct("workspaceId", { userId: ctx.user.id });
      if (transactionSession()) for (const workspaceId of [...workspaces].sort()) await fenceWorkspace(workspaceId);
      if (await PrivateWorkspace.exists({ workspaceId: { $in: workspaces } }) || await PrivateDirectory.exists({ workspaceId: { $in: workspaces } })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verified workspace keys require a signed directory transition and regrant before rotation." });
    }
    const next = await PrivateAccount.findOneAndUpdate({ userId: ctx.user.id, revision: input.revision }, { $set: { identity: input.identity }, $inc: { revision: 1 } }, { returnDocument: "after" }).lean();
    if (!next) throw new TRPCError({ code: "CONFLICT" });
    return { revision: next.revision };
  })),
  createDeviceUnlock: privateAccountProcedure.input(z.object({ requestId: z.uuid(), publicKey: publicEncryptionKeySchema })).mutation(({ ctx, input }) => createPrivateDeviceRequest(ctx.user.id, input.requestId, input.publicKey)),
  // POST avoids caching a one-time key-transfer response in HTTP disk caches.
  deviceUnlockStatus: privateAccountProcedure.input(z.object({ requestId: z.uuid() })).mutation(({ ctx, input }) => privateDeviceStatus(ctx.user.id, input.requestId)),
  approveDeviceUnlock: privateAccountProcedure.input(z.object({ requestId: z.uuid(), box: privateDeviceApprovalSchema })).mutation(({ ctx, input }) => approvePrivateDevice(ctx.user.id, input.requestId, input.box)),
  cancelDeviceUnlock: privateAccountProcedure.input(z.object({ requestId: z.uuid() })).mutation(({ ctx, input }) => cancelPrivateDevice(ctx.user.id, input.requestId)),
  status: privateWorkspaceProcedure.input(scopeSchema).query(async ({ ctx }) => {
    const mode = await PrivateWorkspace.findOne({ workspaceId: ctx.workspaceId }).lean();
    return { mode: mode?.state ?? "standard", revision: mode?.revision ?? 0, owner: ctx.membership.role === "owner" };
  }),
  recipients: privateWorkspaceProcedure.input(scopeSchema).query(async ({ ctx }) => {
    const members = await allMembers(ctx.workspaceId);
    const accounts = await PrivateAccount.find({ userId: { $in: members.map((m) => m.userId) } }).lean();
    return members.map((m) => ({ userId: m.userId, role: m.role, name: m.name, canViewOthersTime: m.canViewOthersTime, canViewOthersMoney: m.canViewOthersMoney, publicKey: accounts.find((a) => a.userId === m.userId)?.identity.publicKey ?? null, signingPublicKey: accounts.find((a) => a.userId === m.userId)?.identity.signingPublicKey ?? null }));
  }),
  records: privateWorkspaceProcedure.input(scopeSchema.extend({ after: z.number().int().nonnegative().default(0), cursor: z.string().max(100).optional() })).query(async ({ ctx, input }) => {
    const mode = await PrivateWorkspace.findOne({ workspaceId: ctx.workspaceId, state: "encrypted" }).lean();
    if (!mode) throw new TRPCError({ code: "PRECONDITION_FAILED" });
    const rows = await PrivateRecord.find({ workspaceId: ctx.workspaceId, "grants.userId": ctx.user.id, revision: { $gt: input.after }, ...(input.cursor ? { _id: { $gt: input.cursor } } : {}) }).sort({ _id: 1 }).limit(201).lean();
    const page = rows.slice(0, 200);
    return { revision: mode.revision, next: rows.length > 200 ? String(page.at(-1)!._id) : null, records: page.map((row) => ({ id: row.id, kind: row.kind, authorId: row.authorId, revision: row.revision, box: row.box, deleted: row.deleted, grants: row.grants.filter((g) => g.userId === ctx.user.id) })) };
  }),
  write: privateWorkspaceProcedure.input(scopeSchema.extend({ expectedRevision: z.number().int().nonnegative(), records: z.array(encryptedRecordSchema).min(1).max(100), remove: z.array(z.object({ kind: encryptedRecordSchema.shape.kind, id: z.string().min(1).max(100) })).max(100).default([]) })).mutation(async ({ ctx, input }) => {
    requirePrivateWorkspaceRollout();
    await requireTransactions();
    return withBusinessTransaction(async () => {
      await fenceWorkspace(ctx.workspaceId);
      const mode = await PrivateWorkspace.findOne({ workspaceId: ctx.workspaceId, state: "encrypted", revision: input.expectedRevision });
      if (!mode) throw new TRPCError({ code: "CONFLICT", message: "Workspace changed. Reload before saving." });
      const members = await allMembers(ctx.workspaceId);
      const revision = mode.revision + 1;
      for (const record of input.records) {
        if (!canWritePrivate(record.kind, record.authorId, ctx.membership)) throw new TRPCError({ code: "FORBIDDEN" });
        validateRecordAudience(record, members);
        const prior = await PrivateRecord.findOne({ workspaceId: ctx.workspaceId, kind: record.kind, id: record.id }).lean();
        if (prior && prior.authorId !== record.authorId) throw new TRPCError({ code: "FORBIDDEN" });
        if (record.revision !== revision) throw new TRPCError({ code: "BAD_REQUEST" });
        await PrivateRecord.updateOne({ workspaceId: ctx.workspaceId, kind: record.kind, id: record.id }, { $set: { ...record, deleted: false } }, { upsert: true });
      }
      for (const row of input.remove) {
        const prior = await PrivateRecord.findOne({ workspaceId: ctx.workspaceId, kind: row.kind, id: row.id }).lean();
        if (!prior || !canWritePrivate(prior.kind, prior.authorId, ctx.membership)) throw new TRPCError({ code: "FORBIDDEN" });
        await PrivateRecord.updateOne({ _id: prior._id }, { $set: { deleted: true, revision } });
      }
      mode.revision = revision; await mode.save();
      return { revision };
    });
  }),
  signedWrite: privateWorkspaceProcedure.input(scopeSchema.extend(signedPrivateWorkspaceEditSchema.shape)).mutation(({ ctx, input }) => {
    requirePrivateWorkspaceRollout();
    if (input.edit.workspaceId !== ctx.workspaceId) throw new TRPCError({ code: "FORBIDDEN" });
    return commitPrivateWorkspaceEdit(ctx.user.id, { edit: input.edit, signature: input.signature, readerSignatures: input.readerSignatures });
  }),
  changes: privateWorkspaceProcedure.input(scopeSchema.extend({ after: z.number().int().nonnegative(), through: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).default(20) })).query(({ ctx, input }) => {
    requirePrivateWorkspaceRollout();
    return privateWorkspaceChanges(ctx.workspaceId, ctx.user.id, input.after, input.through, input.limit);
  }),
  directory: privateWorkspaceProcedure.input(scopeSchema.extend({ after: z.number().int().nonnegative().default(0), through: z.number().int().nonnegative().optional() })).query(({ ctx, input }) => privateDirectoryPage(ctx.workspaceId, ctx.user.id, input.after, input.through)),
  prepareDirectory: privateWorkspaceProcedure.input(scopeSchema.extend({ signed: signedPrivateDirectorySchema })).mutation(({ ctx, input }) => {
    requirePrivateWorkspaceRollout();
    return commitPrivateDirectory({ server: privateServerOrigin(), workspaceId: ctx.workspaceId, userId: ctx.user.id }, input.signed);
  }),
  initialSnapshot: privateWorkspaceProcedure.input(scopeSchema).query(({ ctx }) => {
    requirePrivateWorkspaceRollout();
    return privateInitialSnapshotManifest(ctx.workspaceId, ctx.user.id);
  }),
  initialSnapshotPage: privateWorkspaceProcedure.input(scopeSchema.extend({ migrationId: z.uuid(), offset: z.number().int().nonnegative().max(400_000) })).query(({ ctx, input }) => {
    requirePrivateWorkspaceRollout();
    return privateInitialSnapshotPage(ctx.workspaceId, ctx.user.id, input.migrationId, input.offset);
  }),
  beginMigration: privateWorkspaceProcedure.input(scopeSchema.extend({ sourceRevision: z.string().length(64), signature: signatureSchema })).mutation(({ctx, input}) => beginPrivateMigration(ctx.workspaceId, ctx.user.id, input.sourceRevision, input.signature)),
  stageMigration: privateWorkspaceProcedure.input(scopeSchema.extend({ migrationId: z.string().uuid(), offset: z.number().int().nonnegative().max(400000) })).mutation(({ctx, input}) => stagePrivateMigration(ctx.workspaceId, ctx.user.id, input.migrationId, input.offset)),
  migrationArchive: privateWorkspaceProcedure.input(scopeSchema.extend({ migrationId: z.string().uuid() })).mutation(({ctx, input}) => privateMigrationArchive(ctx.workspaceId, ctx.user.id, input.migrationId)),
  commitMigration: privateWorkspaceProcedure.input(scopeSchema.extend({ migrationId: z.string().uuid(), backupHash: z.string().length(64), signature: signatureSchema })).mutation(({ctx, input}) => commitPrivateMigration(ctx.workspaceId, ctx.user.id, input.migrationId, input.backupHash, input.signature)),
  cancelMigration: privateWorkspaceProcedure.input(scopeSchema.extend({ migrationId: z.string().uuid(), signature: signatureSchema })).mutation(({ctx, input}) => cancelPrivateMigration(ctx.workspaceId, ctx.user.id, input.migrationId, input.signature)),
  recoverySnapshot: privateWorkspaceProcedure.input(scopeSchema).mutation(async ({ ctx }) => workspaceRecovery(ctx.workspaceId, ctx.user.id)),
});
