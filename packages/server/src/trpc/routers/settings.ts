// Settings are stored in two collections and returned as one object.
//
// The split is by owner, not by screen: money and calendar config belong to
// the workspace (everyone must snapshot the same currency), while rendering
// preferences follow the person across every workspace they are in. The wire
// shape stays merged so no client has to change for the storage split.
import { TRPCError } from "@trpc/server";
import {
  updateSettingsSchema,
  type IdleSettings,
  type MaxDurationSettings,
  type ResolvedSettings,
} from "@starter/shared";
import {
  UserPreferencesModel,
  WorkspaceSettingsModel,
  getResolvedSettings,
} from "../../models/Settings.js";
import { publishSync, publishToUser } from "../../ws/sync.js";
import { router, workspaceProcedure } from "../trpc.js";

/** Fields that change what everybody in the workspace sees. */
const WORKSPACE_FIELDS = [
  "defaultHourlyRate",
  "currency",
  "weekStartsOn",
] as const;

export const settingsRouter = router({
  /** The caller's workspace settings merged with their own preferences. */
  get: workspaceProcedure.query(async ({ ctx }): Promise<ResolvedSettings> => {
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
});
