import mongoose, { Schema } from "mongoose";
import type { SignedPrivateTimer } from "@starter/shared";
/** Retained account-owned metadata, never entry bodies or business labels. */
const schema = new Schema<{ userId: string; operationId: string; revision: number; root: string; signed: SignedPrivateTimer }>({
  userId: { type: String, required: true }, operationId: { type: String, required: true }, revision: { type: Number, required: true }, root: { type: String, required: true }, signed: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true, minimize: false });
schema.index({ userId: 1, operationId: 1 }, { unique: true });
schema.index({ userId: 1, revision: 1 }, { unique: true });
export const PrivateTimerVersion = mongoose.model("PrivateTimerVersion", schema);
