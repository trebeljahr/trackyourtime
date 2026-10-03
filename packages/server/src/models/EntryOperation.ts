import mongoose, { Schema } from "mongoose";

/** A retained receipt, committed atomically with the entry writes it describes.
 * No TTL: an offline device may replay after months, or after entry deletion. */
export const EntryOperation = mongoose.model("EntryOperation", new Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  workspaceId: { type: String, required: true, index: true },
  requestHash: { type: String, required: true },
  operation: { type: String, required: true },
  result: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true, minimize: false }));
