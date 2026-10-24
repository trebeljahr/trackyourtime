import mongoose, { Schema } from "mongoose";
import type { EncryptedRecord, PrivateIdentity, PrivateDeviceApproval, PrivateDeviceInvite } from "@starter/shared";
export const PrivateAccount = mongoose.model("PrivateAccount", new Schema<{ userId: string; identity: PrivateIdentity; revision: number; deviceSerial: number; keySerial: number }>({
  userId: { type: String, required: true, unique: true }, identity: { type: Schema.Types.Mixed, required: true }, revision: { type: Number, default: 1 },
  deviceSerial: { type: Number, default: 0 }, keySerial: { type: Number, default: 0 },
}, { timestamps: true }));
export const PrivateWorkspace = mongoose.model("PrivateWorkspace", new Schema<{ workspaceId: string; state: "migrating" | "encrypted"; ownerId: string; revision: number; head: string | null; directoryDigest: string | null; leaseUntil: Date; migrationId: string; sourceRevision: string; backupVerified: boolean }>({
  workspaceId: { type: String, required: true, unique: true }, state: { type: String, enum: ["migrating", "encrypted"], required: true },
  ownerId: { type: String, required: true }, revision: { type: Number, default: 0 }, leaseUntil: { type: Date, required: true },
  head: { type: String, default: null }, directoryDigest: { type: String, default: null },
  migrationId: { type: String, required: true }, sourceRevision: { type: String, required: true }, backupVerified: { type: Boolean, default: false },
}, { timestamps: true }));
const privateRecordSchema = new Schema<EncryptedRecord & { workspaceId: string; deleted: boolean }>({
  workspaceId: { type: String, required: true }, id: { type: String, required: true }, kind: { type: String, required: true }, authorId: { type: String, default: null },
  revision: { type: Number, required: true }, box: { type: Schema.Types.Mixed, required: true }, grants: { type: Schema.Types.Mixed, required: true }, deleted: { type: Boolean, default: false },
}, { timestamps: true });
privateRecordSchema.index({ workspaceId: 1, kind: 1, id: 1 }, { unique: true });
privateRecordSchema.index({ workspaceId: 1, revision: 1 });

export const PrivateRecord = mongoose.model("PrivateRecord", privateRecordSchema);

const privateDeviceRequestSchema = new Schema<{ _id: string; userId: string; publicKey: PrivateDeviceInvite["publicKey"]; box: PrivateDeviceApproval | null; expiresAt: Date }>({
  _id: { type: String, required: true }, userId: { type: String, required: true }, publicKey: { type: Schema.Types.Mixed, required: true },
  box: { type: Schema.Types.Mixed, default: null }, expiresAt: { type: Date, required: true },
}, { timestamps: true });
privateDeviceRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
privateDeviceRequestSchema.index({ userId: 1, expiresAt: 1 });
export const PrivateDeviceRequest = mongoose.model("PrivateDeviceRequest", privateDeviceRequestSchema);

/** Immutable ciphertext journal and replay receipt. One revision per workspace
 * edit; no TTL, so a client that was offline cannot miss a deletion. */
const privateWorkspaceCommitSchema = new Schema<{
  workspaceId: string; userId: string; operationId: string; revision: number;
  manifest: import("@starter/shared").PrivateWorkspaceManifest; signature: string; readerSignatures: { userId: string; signature: string }[];
  records: EncryptedRecord[];
  chain: import("@starter/shared").PrivateWorkspaceChain | null; head: string | null;
}>({
  workspaceId: { type: String, required: true }, userId: { type: String, required: true }, operationId: { type: String, required: true }, revision: { type: Number, required: true },
  manifest: { type: Schema.Types.Mixed, required: true }, signature: { type: String, required: true }, readerSignatures: { type: Schema.Types.Mixed, required: true }, records: { type: Schema.Types.Mixed, required: true },
  chain: { type: Schema.Types.Mixed, default: null }, head: { type: String, default: null },
}, { timestamps: true });
privateWorkspaceCommitSchema.index({ workspaceId: 1, revision: 1 }, { unique: true });
privateWorkspaceCommitSchema.index({ workspaceId: 1, userId: 1, operationId: 1 }, { unique: true });
export const PrivateWorkspaceCommit = mongoose.model("PrivateWorkspaceCommit", privateWorkspaceCommitSchema);


/** Public keys only. Retained with shared workspaces so departed authors'
 * historical signatures remain verifiable after account-key erasure. */
const privateDirectorySchema = new Schema<{
  workspaceId: string; revision: number; digest: string;
  signerPublicKey: import("@starter/core").PublicKey; signed: import("@starter/shared").SignedPrivateDirectory;
}>({
  workspaceId: { type: String, required: true }, revision: { type: Number, required: true }, digest: { type: String, required: true },
  signerPublicKey: { type: Schema.Types.Mixed, required: true }, signed: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
privateDirectorySchema.index({ workspaceId: 1, revision: 1 }, { unique: true });
export const PrivateDirectory = mongoose.model("PrivateDirectory", privateDirectorySchema);

/** Immutable initial ciphertext, split below MongoDB's document size limit.
 * Reader-specific indexes stay server-side; public pages expose logical offsets
 * only, so sparse private records do not reveal other readers' chunk counts. */
const privateSnapshotChunkSchema = new Schema<{
  workspaceId: string; migrationId: string; index: number; records: EncryptedRecord[];
}>({
  workspaceId: { type: String, required: true }, migrationId: { type: String, required: true },
  index: { type: Number, required: true }, records: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
privateSnapshotChunkSchema.index({ workspaceId: 1, migrationId: 1, index: 1 }, { unique: true });
export const PrivateSnapshotChunk = mongoose.model("PrivateSnapshotChunk", privateSnapshotChunkSchema);
const privateSnapshotReaderSchema = new Schema<{
  workspaceId: string; migrationId: string; userId: string; fullRecordsDigest: string;
  signed: import("@starter/shared").SignedPrivateInitialSnapshot;
  locations: { chunk: number; before: number; count: number }[];
}>({
  workspaceId: { type: String, required: true }, migrationId: { type: String, required: true }, userId: { type: String, required: true },
  fullRecordsDigest: { type: String, required: true }, signed: { type: Schema.Types.Mixed, required: true }, locations: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
privateSnapshotReaderSchema.index({ workspaceId: 1, migrationId: 1, userId: 1 }, { unique: true });
export const PrivateSnapshotReader = mongoose.model("PrivateSnapshotReader", privateSnapshotReaderSchema);

/** Signed content-verification receipts contain checksums and counts only,
 * never the member's original plaintext preferences or private keys. */
const privateMigrationReceiptSchema = new Schema<{
  workspaceId: string; migrationId: string; userId: string; kind: "owner" | "favorites";
  proof: Record<string, unknown>; signature: string;
}>({
  workspaceId: { type: String, required: true }, migrationId: { type: String, required: true }, userId: { type: String, required: true },
  kind: { type: String, enum: ["owner", "favorites"], required: true }, proof: { type: Schema.Types.Mixed, required: true }, signature: { type: String, required: true },
}, { timestamps: true });
privateMigrationReceiptSchema.index({ workspaceId: 1, migrationId: 1, userId: 1, kind: 1 }, { unique: true });
export const PrivateMigrationReceipt = mongoose.model("PrivateMigrationReceipt", privateMigrationReceiptSchema);
