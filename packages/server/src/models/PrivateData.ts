import mongoose, { Schema } from "mongoose";
import type { EncryptedRecord, PrivateIdentity, PrivateDeviceApproval, PrivateDeviceInvite } from "@starter/shared";
export const PrivateAccount = mongoose.model("PrivateAccount", new Schema<{ userId: string; identity: PrivateIdentity; revision: number; deviceSerial: number }>({
  userId: { type: String, required: true, unique: true }, identity: { type: Schema.Types.Mixed, required: true }, revision: { type: Number, default: 1 },
  deviceSerial: { type: Number, default: 0 },
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
