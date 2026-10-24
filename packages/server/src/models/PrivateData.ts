import mongoose, { Schema } from "mongoose";
import type { EncryptedRecord, PrivateIdentity, PrivateDeviceApproval, PrivateDeviceInvite } from "@starter/shared";
export const PrivateAccount = mongoose.model("PrivateAccount", new Schema<{ userId: string; identity: PrivateIdentity; revision: number; deviceSerial: number; keySerial: number }>({
  userId: { type: String, required: true, unique: true }, identity: { type: Schema.Types.Mixed, required: true }, revision: { type: Number, default: 1 },
  deviceSerial: { type: Number, default: 0 }, keySerial: { type: Number, default: 0 },
}, { timestamps: true }));
export const PrivateWorkspace = mongoose.model("PrivateWorkspace", new Schema<{ workspaceId: string; state: "migrating" | "encrypted"; ownerId: string; revision: number; leaseUntil: Date; migrationId: string; sourceRevision: string; backupVerified: boolean }>({
  workspaceId: { type: String, required: true, unique: true }, state: { type: String, enum: ["migrating", "encrypted"], required: true },
  ownerId: { type: String, required: true }, revision: { type: Number, default: 0 }, leaseUntil: { type: Date, required: true },
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
}>({
  workspaceId: { type: String, required: true }, userId: { type: String, required: true }, operationId: { type: String, required: true }, revision: { type: Number, required: true },
  manifest: { type: Schema.Types.Mixed, required: true }, signature: { type: String, required: true }, readerSignatures: { type: Schema.Types.Mixed, required: true }, records: { type: Schema.Types.Mixed, required: true },
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
