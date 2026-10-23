import mongoose, { Schema } from "mongoose";

/** Accounted application bytes, including per-record and running-timer reserves. */
export const StorageUsage = mongoose.model("StorageUsage", new Schema({
  _id: { type: String, required: true }, // workspace id
  bytes: { type: Number, required: true },
  version: { type: Number, required: true },
}));

/** Durable contention points; no expiring lease can admit two concurrent writers. */
export const StorageFence = mongoose.model("StorageFence", new Schema({
  _id: { type: String, required: true },
  revision: { type: Number, default: 0 },
}));
