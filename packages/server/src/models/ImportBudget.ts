import mongoose, { Schema } from "mongoose";

/** Shared across processes; one counter for each user/workspace and hour. */
export const ImportBudget = mongoose.model("ImportBudget", new Schema({
  _id: { type: String, required: true },
  attempts: { type: Number, required: true },
  bytes: { type: Number, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}));

/** Lease rows never use TTL: deleting a live row would erase its owner. */
export const ImportLease = mongoose.model("ImportLease", new Schema({
  _id: { type: String, required: true },
  token: { type: String, default: null },
  until: { type: Date, required: true },
  revision: { type: Number, default: 0 },
}));
