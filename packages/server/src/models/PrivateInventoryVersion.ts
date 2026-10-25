import mongoose, { Schema } from "mongoose";
import type { SignedPrivateInventoryVersion } from "@starter/shared";
/** Immutable account-owned ciphertext history. Never stores inventory plaintext
 * or master keys. Its separate bounded metadata budget is enforced in service. */
const schema = new Schema<{
  userId: string; revision: number; operationId: string; root: string; signed: SignedPrivateInventoryVersion; bytes: number;
}>({
  userId: { type: String, required: true }, revision: { type: Number, required: true }, operationId: { type: String, required: true },
  root: { type: String, required: true }, signed: { type: Schema.Types.Mixed, required: true }, bytes: { type: Number, required: true },
}, { timestamps: true });
schema.index({ userId: 1, revision: 1 }, { unique: true });
schema.index({ userId: 1, operationId: 1 }, { unique: true });
export const PrivateInventoryVersion = mongoose.model("PrivateInventoryVersion", schema);
