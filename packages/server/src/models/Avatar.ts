import mongoose, { Schema, type Document } from "mongoose";

/**
 * One profile picture per user, stored as bytes in the database.
 *
 * In the database rather than object storage because a self-hosted instance
 * has a database and nothing else, and because a picture is at most
 * `MAX_AVATAR_BYTES` (256 KB): a few thousand accounts are a few hundred
 * megabytes, which is not worth a second service.
 *
 * `key` is 128 random bits, regenerated on every upload. It is part of the
 * public URL, which makes the URL unguessable (the route is unauthenticated,
 * because an `<img>` cannot send a bearer token) and makes every new upload a
 * new address, so a cached old picture is never served for a new one.
 */
export interface IAvatar extends Document {
  userId: string;
  key: string;
  contentType: string;
  size: number;
  bytes: Buffer;
  createdAt: Date;
  updatedAt: Date;
}

const avatarSchema = new Schema<IAvatar>(
  {
    userId: { type: String, required: true, unique: true },
    key: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    bytes: { type: Buffer, required: true },
  },
  { timestamps: true },
);

export const Avatar = mongoose.model<IAvatar>("Avatar", avatarSchema);
