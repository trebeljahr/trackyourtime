// Settings are stored in two collections and returned as one object.
//
// The split is by owner, not by screen: money and calendar config belong to
// the workspace (everyone must snapshot the same currency), while rendering
// preferences follow the person across every workspace they are in. The wire
// shape stays merged so no client has to change for the storage split.
import { TRPCError } from "@trpc/server";
import {
  updateBusinessProfileSchema,
  updateSettingsSchema,
  type BusinessProfile,
  type IdleSettings,
  type MaxDurationSettings,
  type ResolvedSettings,
  workspaceScopeSchema,
} from "@starter/shared";
import {
  UserPreferencesModel,
  WorkspaceSettingsModel,
  getResolvedSettings,
} from "../../models/Settings.js";
import {
  BusinessProfileInvalidError,
  getBusinessProfile,
  saveBusinessProfile,
} from "../../models/BusinessProfile.js";
import { publishSync, publishToUser } from "../../ws/sync.js";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import {
  readReleaseCheck,
  updateNoticeFor,
  type UpdateNotice,
} from "../../services/update-check.js";
import { router, workspaceProcedure } from "../trpc.js";

/** Fields that change what everybody in the workspace sees. */
const WORKSPACE_FIELDS = [
  "defaultHourlyRate",
  "currency",
  "weekStartsOn",
] as const;

/**
 * The business profile sits with invoices, not with display settings: it is
 * printed on every invoice and carries payment details, so reading it takes
 * what reading an invoice takes — owner/admin, or a member trusted with the
 * workspace's money — and changing it is an owner's or admin's job.
 */
type RoleGateContext = {
  membership: { role: string };
  visibility: { canViewOthersMoney: boolean };
};

function assertMayReadBusinessProfile(ctx: RoleGateContext): void {
  if (ctx.membership.role !== "member" || ctx.visibility.canViewOthersMoney) {
    return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Your workspace role cannot see the business profile",
  });
}

export const settingsRouter = router({
  /** The caller's workspace settings merged with their own preferences. */
  get: workspaceProcedure.input(workspaceScopeSchema).query(async ({ ctx }): Promise<ResolvedSettings> => {
    return getResolvedSettings(ctx.workspaceId, ctx.user.id);
  }),

  /** Partial update — omitted fields keep their current value. */
  update: workspaceProcedure
    .input(updateSettingsSchema)
    .mutation(async ({ ctx, input }): Promise<ResolvedSettings> => {
      const touchesWorkspace = WORKSPACE_FIELDS.some(
        (field) => input[field] !== undefined,
      );

      // Currency and the default rate reprice everybody's future entries, so
      // they are not an ordinary member's to change. Personal workspaces are
      // unaffected: their single member is the owner.
      if (touchesWorkspace && ctx.membership.role === "member") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an owner or admin can change workspace settings",
        });
      }

      if (touchesWorkspace) {
        await WorkspaceSettingsModel.updateOne(
          { workspaceId: ctx.workspaceId },
          {
            $set: {
              ...(input.defaultHourlyRate !== undefined
                ? { defaultHourlyRate: input.defaultHourlyRate }
                : {}),
              ...(input.currency !== undefined
                ? { currency: input.currency }
                : {}),
              ...(input.weekStartsOn !== undefined
                ? { weekStartsOn: input.weekStartsOn }
                : {}),
            },
          },
          { upsert: true },
        );
      }

      const touchesUser =
        input.timeFormat !== undefined ||
        input.durationFormat !== undefined ||
        input.theme !== undefined ||
        input.locale !== undefined ||
        input.idle !== undefined ||
        input.maxDuration !== undefined;

      if (touchesUser) {
        const current = await getResolvedSettings(ctx.workspaceId, ctx.user.id);
        const idle: IdleSettings = {
          ...current.idle,
          ...(input.idle ?? {}),
        };
        // A personal preference too, for the reason written on
        // MaxDurationSettings: the guard acts on the one timer a person has
        // running, wherever it lives, so the workspace does not get to decide
        // how long their day may be.
        const maxDuration: MaxDurationSettings = {
          ...current.maxDuration,
          ...(input.maxDuration ?? {}),
        };

        await UserPreferencesModel.updateOne(
          { userId: ctx.user.id },
          {
            $set: {
              timeFormat: input.timeFormat ?? current.timeFormat,
              durationFormat: input.durationFormat ?? current.durationFormat,
              theme: input.theme ?? current.theme,
              locale: input.locale ?? current.locale,
              idle,
              maxDuration,
            },
          },
          { upsert: true },
        );
      }

      const settings = await getResolvedSettings(ctx.workspaceId, ctx.user.id);

      // A workspace change is everybody's business; a preference change is
      // only this person's, and must not wake their colleagues' clients.
      if (touchesWorkspace) {
        void publishSync(
          ctx.workspaceId,
          { kind: "settings.changed" },
          input.originId,
        );
      } else {
        publishToUser(
          ctx.user.id,
          { kind: "settings.changed" },
          input.originId,
        );
      }

      return settings;
    }),

  /** The workspace's issuer profile; the empty profile before the first save. */
  businessProfile: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<BusinessProfile> => {
      assertMayReadBusinessProfile(ctx);
      return getBusinessProfile(ctx.workspaceId);
    },
  ),

  /**
   * Replace the business profile as a whole. Existing invoices keep the
   * issuer they were created with; only the next `invoices.create` sees this.
   */
  updateBusinessProfile: workspaceProcedure
    .input(updateBusinessProfileSchema)
    .mutation(async ({ ctx, input }): Promise<BusinessProfile> => {
      if (ctx.membership.role === "member") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an owner or admin can change the business profile",
        });
      }
      const { originId, ...fields } = input;
      let profile: BusinessProfile;
      try {
        profile = await saveBusinessProfile(ctx.workspaceId, fields);
      } catch (error) {
        // A cross-field rule failed on the MERGED row (a key the input left
        // out kept a stored value the new ones contradict). That is the
        // caller's input, not a server fault.
        if (error instanceof BusinessProfileInvalidError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
        }
        throw error;
      }
      void publishSync(ctx.workspaceId, { kind: "settings.changed" }, originId);
      return profile;
    }),

  /**
   * "vX.Y.Z is available", for a workspace owner or admin, when the server
   * runs with TRACKYOURTIME_UPDATE_CHECK and the daily check found a newer
   * stable release. Null for everybody else and whenever the check is off, so
   * the answer never says whether the check is configured. Reads the stored
   * result only; this request never calls GitHub.
   */
  updateNotice: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<UpdateNotice | null> => {
      if (!env.TRACKYOURTIME_UPDATE_CHECK) return null;
      if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") return null;
      const db = mongoose.connection.db;
      if (!db) return null;
      return updateNoticeFor(await readReleaseCheck(db), env.RELEASE);
    },
  ),
});
