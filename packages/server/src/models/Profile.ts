import mongoose, { Schema, type Document } from "mongoose";
import type { ThemePreference } from "@starter/shared";

export interface IProfile extends Document {
  userId: string;
  avatarUrl?: string;
  bio?: string;
  preferences: {
    theme: ThemePreference;
    notifications: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new Schema<IProfile>(
  {
    userId: { type: String, required: true, unique: true },
    avatarUrl: String,
    bio: { type: String, maxlength: 500 },
    preferences: {
      theme: {
        type: String,
        enum: ["light", "dark", "system"],
        default: "system",
      },
      // Nothing reads this any more: the forgotten-timer email has its own
      // switch, `maxDuration.emailReminder` on UserPreferences. Kept for the
      // older clients that still show and write it, and off by default so it
      // never claims a choice the person did not make.
      notifications: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

export const Profile = mongoose.model<IProfile>("Profile", profileSchema);
