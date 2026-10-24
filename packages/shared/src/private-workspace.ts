import { z } from "zod";
import { encryptedRecordSchema, privateKindSchema, publicEncryptionKeySchema } from "./privacy.js";
const id = z.string().min(1).max(100);
export const privateRecordRefSchema = z.object({ kind: privateKindSchema, id, authorId: id.nullable() }).strict();
export const privateRemovalSchema = privateRecordRefSchema.extend({ readers: z.array(id).min(1).max(200) }).strict();
export const privateWorkspaceEditSchema = z.object({
  v: z.literal(1), workspaceId: id, userId: id, operationId: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  records: z.array(encryptedRecordSchema).max(100), remove: z.array(privateRemovalSchema).max(100),
}).strict();
export const privateWorkspaceManifestSchema = privateWorkspaceEditSchema.omit({ records: true }).extend({
  protocol: z.literal("trackyourtime-private-workspace-edit-v1"), readerId: id.nullable(),
  records: z.array(privateRecordRefSchema.extend({ hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), readers: z.array(id).min(1).max(200) }).strict()).max(100),
}).strict();
export const privateSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const signedPrivateWorkspaceEditSchema = z.object({ edit: privateWorkspaceEditSchema, signature: privateSignatureSchema, readerSignatures: z.array(z.object({ userId: id, signature: privateSignatureSchema }).strict()).min(1).max(200) }).strict();
export const privateWorkspaceChangeSchema = z.object({
  revision: z.number().int().positive(), manifest: privateWorkspaceManifestSchema, signature: privateSignatureSchema, records: z.array(encryptedRecordSchema).max(100),
}).strict();
export type PrivateWorkspaceEdit = z.infer<typeof privateWorkspaceEditSchema>;
export type PrivateWorkspaceManifest = z.infer<typeof privateWorkspaceManifestSchema>;
export type SignedPrivateWorkspaceEdit = z.infer<typeof signedPrivateWorkspaceEditSchema>;
export type PrivateWorkspaceChange = z.infer<typeof privateWorkspaceChangeSchema>;
export const PRIVATE_EDIT_MAX_BYTES = 4 * 1024 * 1024;

export const privateDirectoryMemberSchema = z.object({
  userId: id, role: z.enum(["owner", "admin", "member"]), canViewOthersTime: z.boolean(), canViewOthersMoney: z.boolean(),
  publicKey: publicEncryptionKeySchema, signingPublicKey: publicEncryptionKeySchema,
}).strict();
export const privateWorkspaceDirectorySchema = z.object({
  v: z.literal(1), server: z.string().url().max(2048), workspaceId: id, revision: z.number().int().positive(), previousDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(), ownerId: id,
  members: z.array(privateDirectoryMemberSchema).min(1).max(200),
}).strict();
export const signedPrivateDirectorySchema = z.object({ directory: privateWorkspaceDirectorySchema, signerId: id, signature: privateSignatureSchema }).strict();
export type PrivateDirectoryMember = z.infer<typeof privateDirectoryMemberSchema>;
export type PrivateWorkspaceDirectory = z.infer<typeof privateWorkspaceDirectorySchema>;
export type SignedPrivateDirectory = z.infer<typeof signedPrivateDirectorySchema>;
