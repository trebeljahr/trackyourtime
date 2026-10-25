import mongoose, { Schema } from "mongoose";
/** A one-way opaque account-ID commitment, retained after erasure to refuse
 * delayed authenticated key writes. Contains no email, keys or ciphertext. */
export const PrivateAccountErasureFence = mongoose.model("PrivateAccountErasureFence", new Schema<{
  _id: string; erased: boolean; serial: number;
}>({ _id: { type: String, required: true }, erased: { type: Boolean, required: true }, serial: { type: Number, required: true } }, { versionKey: false }));
