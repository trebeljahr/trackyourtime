import { z } from "zod";
export const cipherSchema = z.object({ v: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/), data: z.string().min(22).max(2_000_000).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export const publicEncryptionKeySchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ext: z.boolean().optional(), key_ops: z.array(z.string()).optional() }).strict();
export const recipientBoxSchema = z.object({ v: z.literal(1), ephemeral: publicEncryptionKeySchema, box: cipherSchema }).strict();
export const PRIVATE_KINDS = ["entries", "entryMoney", "clients", "clientMoney", "projects", "projectMoney", "tasks", "tags", "favorites", "invoices", "settings", "businessProfile", "approvals", "approvalPolicy", "imports", "memberMoney", "settingsMoney"] as const;
export const privateKindSchema = z.enum(PRIVATE_KINDS);
export type PrivateKind = typeof PRIVATE_KINDS[number];
export const encryptedRecordSchema = z.object({
  id: z.string().min(1).max(100), kind: privateKindSchema, authorId: z.string().min(1).max(100).nullable(),
  revision: z.number().int().nonnegative(),
  box: cipherSchema,
  grants: z.array(z.object({ userId: z.string().min(1).max(100), envelope: recipientBoxSchema }).strict()).min(1).max(200),
}).strict();
export type EncryptedRecord = z.infer<typeof encryptedRecordSchema>;
export type PrivateCiphertext = z.infer<typeof cipherSchema>;
const identityEnvelopeSchema = cipherSchema.extend({ data: cipherSchema.shape.data.max(16_384) });
export const privateIdentitySchema = z.object({ publicKey: publicEncryptionKeySchema, signingPublicKey: publicEncryptionKeySchema, recovery: identityEnvelopeSchema, passkeys: z.array(z.object({ credentialId: z.string().min(1).max(1500), envelope: identityEnvelopeSchema }).strict()).max(20) }).strict();
export type PrivateIdentity = z.infer<typeof privateIdentitySchema>;
export const RECOVERY_KINDS = ["timeentries", "entryoperations", "clients", "projects", "tasks", "tags", "favorites", "invoices", "importbatches", "workspacesettings", "businessprofiles", "timesheetapprovals", "timesheetpolicies", "workspacemembers"] as const;
export type RecoveryKind = typeof RECOVERY_KINDS[number];
export type WorkspaceRecovery = { v: 1; workspaceId: string; createdAt: string; sourceRevision: string; collections: Record<RecoveryKind, Record<string, unknown>[]> };
/** Leaves room for the archive header and password envelope's 24 MiB limit. */
export const RECOVERY_MAX_BYTES = 23 * 1024 * 1024;
export const RECOVERY_MAX_RECORDS = 200_000;
export type WorkspaceRecoveryArchive = { format: "trackyourtime-workspace-recovery-v1"; server: string; ownerId: string; snapshot: WorkspaceRecovery };
export const PRIVATE_WORKSPACE_REQUIRED = "PRIVATE_WORKSPACE_REQUIRES_UNLOCK";
