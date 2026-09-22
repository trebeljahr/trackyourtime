import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { setAvatarSchema, updateProfileSchema } from "@starter/shared";
import { Profile } from "../../models/Profile.js";
import { removeAvatar, storeAvatar } from "../../services/avatar/index.js";

export const profileRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    let profile = await Profile.findOne({ userId: ctx.user.id });
    if (!profile) {
      profile = await Profile.create({
        userId: ctx.user.id,
        preferences: { theme: "system", notifications: true },
      });
    }
    return {
      userId: profile.userId,
      avatarUrl: profile.avatarUrl,
      bio: profile.bio,
      preferences: profile.preferences,
    };
  }),

  update: protectedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ ctx, input }) => {
      const update: Record<string, unknown> = {};
      if (input.bio !== undefined) update.bio = input.bio;
      if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;
      if (input.preferences) {
        if (input.preferences.theme !== undefined) {
          update["preferences.theme"] = input.preferences.theme;
        }
        if (input.preferences.notifications !== undefined) {
          update["preferences.notifications"] = input.preferences.notifications;
        }
      }

      const profile = await Profile.findOneAndUpdate(
        { userId: ctx.user.id },
        { $set: update },
        { returnDocument: "after", upsert: true },
      );

      return {
        userId: profile.userId,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        preferences: profile.preferences,
      };
    }),

  /**
   * Settings → Account / Profile → profile picture. The client sends a square
   * of `AVATAR_SIZE` pixels as base64; the bytes are checked by magic number
   * and size (`services/avatar`), stored, and `user.image` is pointed at the
   * new address. Refused with BAD_REQUEST and one of `AVATAR_REFUSALS` as the
   * message. The caller re-reads its session afterwards: the web app's cookie
   * cache still holds the old `image` for up to five minutes.
   */
  setAvatar: protectedProcedure
    .input(setAvatarSchema)
    .mutation(async ({ ctx, input }) => {
      const outcome = await storeAvatar(ctx.user.id, input.data);
      if (!outcome.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: outcome.refusal });
      }
      return { image: outcome.image };
    }),

  /** Delete the stored picture and clear `user.image`, whatever it held. */
  removeAvatar: protectedProcedure.mutation(async ({ ctx }) => {
    await removeAvatar(ctx.user.id);
    return { image: null };
  }),
});
