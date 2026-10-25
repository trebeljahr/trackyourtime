import { z } from "zod";
import { encryptedRecordSchema, privateKindSchema, publicEncryptionKeySchema, type PrivateKind } from "./privacy.js";
import { canUseInvoices } from "./visibility.js";
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

/** Initial encrypted state is larger than one ordinary edit. Each reader gets
 * a separately signed complete projection, including an authenticated empty
 * projection. Other members' private record IDs and counts stay out of it. */
export const privateInitialSnapshotManifestSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-initial-snapshot-v2"),
  server: z.string().url().max(2048), workspaceId: id, migrationId: z.uuid(),
  revision: z.literal(1), directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  root: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signerId: id, readerId: id, recordCount: z.number().int().nonnegative().max(400_000),
  recordsDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export const signedPrivateInitialSnapshotSchema = z.object({
  manifest: privateInitialSnapshotManifestSchema, signature: privateSignatureSchema,
}).strict();
export type SignedPrivateInitialSnapshot = z.infer<typeof signedPrivateInitialSnapshotSchema>;
export const PRIVATE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const PRIVATE_SNAPSHOT_PAGE_MAX_BYTES = 4 * 1024 * 1024;

export function canWritePrivateRecord(kind: PrivateKind, authorId: string | null, actor: Pick<PrivateDirectoryMember, "userId" | "role" | "canViewOthersTime" | "canViewOthersMoney">): boolean {
  if (["entries", "entryMoney", "favorites", "imports", "integrations"].includes(kind)) return authorId === actor.userId;
  if (kind === "invoices") return canUseInvoices(actor.role, { userId: actor.userId, canViewOthersTime: actor.role === "owner" || actor.canViewOthersTime, canViewOthersMoney: actor.role === "owner" || actor.canViewOthersMoney });
  if (kind === "memberMoney") return actor.role === "owner" || (actor.role === "admin" && actor.canViewOthersMoney);
  return actor.role === "owner" || actor.role === "admin";
}
export const privateWorkspaceChainHeaderSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-workspace-chain-v1"),
  server: z.string().url().max(2048), workspaceId: id, userId: id,
  operationId: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), previousRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  manifestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  readers: z.array(z.object({ userId: id, digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()).min(1).max(200),
}).strict();
export const privateWorkspaceChainSchema = z.object({ header: privateWorkspaceChainHeaderSchema, signature: privateSignatureSchema }).strict();
export const signedPrivateChainedEditSchema = signedPrivateWorkspaceEditSchema.extend({ chain: privateWorkspaceChainSchema }).strict();
export const privateChainedWorkspaceChangeSchema = privateWorkspaceChangeSchema.extend({ chain: privateWorkspaceChainSchema }).strict();
export type PrivateWorkspaceChain = z.infer<typeof privateWorkspaceChainSchema>;
export type SignedPrivateChainedEdit = z.infer<typeof signedPrivateChainedEditSchema>;
export type PrivateChainedWorkspaceChange = z.infer<typeof privateChainedWorkspaceChangeSchema>;

export const privateFavoritesMigrationProofSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-favorites-proof-v1"),
  server: z.string().url().max(2048), workspaceId: id, userId: id, migrationId: z.uuid(),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), snapshotRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), recordsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedRecords: z.number().int().nonnegative().max(200_000),
}).strict();
export const signedPrivateFavoritesMigrationProofSchema = z.object({ proof: privateFavoritesMigrationProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateFavoritesMigrationProof = z.infer<typeof signedPrivateFavoritesMigrationProofSchema>;

/** Temporary preparation receipt. Plaintext-derived sourceRevision must be
 * removed with the source at conversion; only ciphertext commitments may stay. */
export const privateOwnerMigrationProofSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-owner-proof-v1"),
  server: z.string().url().max(2048), workspaceId: id, userId: id, migrationId: z.uuid(),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), snapshotRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), recordsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  backupDigest: z.string().regex(/^[a-f0-9]{64}$/), backupBytes: z.number().int().positive().max(36 * 1024 * 1024),
  verifiedRecords: z.number().int().nonnegative().max(400_000), opaqueRecords: z.number().int().nonnegative().max(400_000),
}).strict();
export const signedPrivateOwnerMigrationProofSchema = z.object({ proof: privateOwnerMigrationProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateOwnerMigrationProof = z.infer<typeof signedPrivateOwnerMigrationProofSchema>;

/** A v1 owner receipt never covers integration/organization originals. These
 * temporary plaintext checksums must also retire when conversion completes. */
export const privateCombinedOwnerMigrationProofSchema = privateOwnerMigrationProofSchema.extend({
  v: z.literal(2), protocol: z.literal("trackyourtime-private-owner-proof-v2"),
  supplementRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const signedPrivateCombinedOwnerMigrationProofSchema = z.object({ proof: privateCombinedOwnerMigrationProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateCombinedOwnerMigrationProof = z.infer<typeof signedPrivateCombinedOwnerMigrationProofSchema>;

export const privatePersonalMigrationProofSchema = privateCombinedOwnerMigrationProofSchema.omit({ opaqueRecords: true }).extend({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-personal-proof-v1"),
  verifiedRecords: z.number().int().nonnegative().max(200_000),
}).strict();
export const signedPrivatePersonalMigrationProofSchema = z.object({ proof: privatePersonalMigrationProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivatePersonalMigrationProof = z.infer<typeof signedPrivatePersonalMigrationProofSchema>;

export const PRIVATE_SOURCE_CHALLENGE_TTL_MS = 120_000;
export const privateSourceChallengeSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-source-challenge-v1"), requestId: z.uuid(),
  server: z.string().url().max(2048), workspaceId: id, userId: id,
  purpose: z.enum(["workspace-originals", "personal-originals"]), migrationId: z.uuid().nullable(),
  sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/), keyFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
}).strict();
export const signedPrivateSourceChallengeSchema = z.object({ challenge: privateSourceChallengeSchema, signature: privateSignatureSchema }).strict();
export type PrivateSourceChallenge = z.infer<typeof privateSourceChallengeSchema>;
export type SignedPrivateSourceChallenge = z.infer<typeof signedPrivateSourceChallengeSchema>;

/** Proposed initial delivery format: shared projections are computed by the
 * owner from visible shared ciphertext; opaque personal digests disclose no
 * other creator's private record IDs or exact counts. Not publicly mounted. */
export const privateInitialProjectionRootSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-initial-projections-v3"),
  server: z.string().url().max(2048), workspaceId: id, migrationId: z.uuid(), revision: z.literal(1),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), signerId: id,
  readers: z.array(z.object({ userId: id, sharedDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), personalDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()).min(1).max(200),
}).strict();
export const signedPrivateInitialProjectionRootSchema = z.object({ manifest: privateInitialProjectionRootSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateInitialProjectionRoot = z.infer<typeof signedPrivateInitialProjectionRootSchema>;

export const privateProjectionOwnerProofSchema = privateCombinedOwnerMigrationProofSchema.omit({ opaqueRecords: true }).extend({
  v: z.literal(3), protocol: z.literal("trackyourtime-private-owner-proof-v3"),
}).strict();
export const signedPrivateProjectionOwnerProofSchema = z.object({ proof: privateProjectionOwnerProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateProjectionOwnerProof = z.infer<typeof signedPrivateProjectionOwnerProofSchema>;
export const privateProjectionPersonalProofSchema = privatePersonalMigrationProofSchema.extend({
  v: z.literal(2), protocol: z.literal("trackyourtime-private-personal-proof-v2"),
}).strict();
export const signedPrivateProjectionPersonalProofSchema = z.object({ proof: privateProjectionPersonalProofSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateProjectionPersonalProof = z.infer<typeof signedPrivateProjectionPersonalProofSchema>;

export const PRIVATE_PREPARATION_REQUEST_TTL_MS = 2 * 60_000;
/** Internal client-preparation intent; no public begin route accepts it yet. */
export const privatePreparationRequestSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-preparation-v2"),
  server: z.string().url().max(2048), workspaceId: id, userId: id, migrationId: z.uuid(),
  directoryDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), supplementRevision: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const signedPrivatePreparationRequestSchema = z.object({ request: privatePreparationRequestSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivatePreparationRequest = z.infer<typeof signedPrivatePreparationRequestSchema>;
export const privateOriginalStageRequestSchema = privatePreparationRequestSchema.omit({ sourceRevision: true, supplementRevision: true }).extend({
  protocol: z.literal("trackyourtime-private-original-stage-v1"),
}).strict();
export const signedPrivateOriginalStageRequestSchema = z.object({ request: privateOriginalStageRequestSchema, signature: privateSignatureSchema }).strict();
export type SignedPrivateOriginalStageRequest = z.infer<typeof signedPrivateOriginalStageRequestSchema>;
