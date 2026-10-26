import mongoose, { Schema } from "mongoose";
import type { SignedPrivatePreparationReservation } from "@starter/shared";
import type { PublicKey } from "@starter/core";
import type { SignedOperatorCheckpointProof } from "../services/privacy/operator-checkpoint.js";
/** Permanent preparation hold. No TTL: frozen ciphertext must survive the
 * former lease once a device may have irreversibly pinned its root. */
const schema = new Schema<{
  workspaceId: string; modeId: string; migrationId: string; root: string; directoryDigest: string;
  ownerId: string; memberIds: string[]; ownerSigningPublicKey: PublicKey;
  consent: SignedPrivatePreparationReservation; operator: SignedOperatorCheckpointProof;
}>({
  workspaceId: { type: String, required: true, unique: true }, modeId: { type: String, required: true },
  migrationId: { type: String, required: true }, root: { type: String, required: true }, directoryDigest: { type: String, required: true },
  ownerId: { type: String, required: true }, memberIds: { type: [String], required: true }, ownerSigningPublicKey: { type: Schema.Types.Mixed, required: true },
  consent: { type: Schema.Types.Mixed, required: true }, operator: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ memberIds: 1 });
export const PrivatePreparationReservation = mongoose.model("PrivatePreparationReservation", schema);
