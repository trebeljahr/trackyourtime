// Settings live in two collections, because they answer to two different
// owners.
//
//  - WorkspaceSettings — money and calendar. Shared by everyone in the
//    workspace. `currency` CANNOT be per-user: every entry snapshots it and a
//    report carries exactly one currency for the whole result, so two members
//    with different personal currencies would make that field a lie.
//  - UserPreferences — how a person likes things rendered. Follows the human
//    across every workspace they belong to.
//
// The wire shape stays merged for now (see `getResolvedSettings`), so the
// storage split — the expensive-to-change part — lands without any client
// having to change. Splitting the procedure is a later, reversible step.
import mongoose, { Schema, type Document } from "mongoose";
import {
  DEFAULT_IDLE_SETTINGS,
  DEFAULT_MAX_DURATION_SETTINGS,
  IDLE_BEHAVIORS,
  LOCALE_PREFERENCES,
  MAX_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  RUNAWAY_BEHAVIORS,
} from "@starter/shared";
import type {
  DurationFormat,
  IdleSettings,
  LocalePreference,
  MaxDurationSettings,
  ResolvedSettings,
  ThemePreference,
  TimeFormat,
  UserPreferences,
  WeekStart,
  WorkspaceSettings,
} from "@starter/shared";

export const DEFAULT_WORKSPACE_SETTINGS: Omit<WorkspaceSettings, "workspaceId"> = {
  defaultHourlyRate: 0,
  currency: "EUR",
  weekStartsOn: 1,
};

/** Re-exported under the model's naming so the two defaults read alike. */
export const DEFAULT_IDLE: IdleSettings = DEFAULT_IDLE_SETTINGS;

/**
 * Unlike idle, the runaway guard ships ON — see the note in
 * `@starter/shared/runaway`. Its default behaviour cannot lose a second, and a
 * guard that is off by default catches nothing.
 */
export const DEFAULT_MAX_DURATION: MaxDurationSettings =
  DEFAULT_MAX_DURATION_SETTINGS;

export const DEFAULT_USER_PREFERENCES: Omit<UserPreferences, "userId"> = {
  timeFormat: "24h",
  durationFormat: "hms",
  // "system" rather than "light": a client that has not been told otherwise
  // should follow the machine, which is what every one of them did before this
  // preference was stored at all.
  theme: "system",
  // "system" for the same reason: every client already followed the device
  // language before anybody could choose one.
  locale: "system",
  idle: DEFAULT_IDLE,
  maxDuration: DEFAULT_MAX_DURATION,
};

// ── workspace settings ───────────────────────────────────────────────

export interface IWorkspaceSettings extends Document {
  workspaceId: string;
  defaultHourlyRate: number;
  currency: string;
  weekStartsOn: WeekStart;
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSettingsSchema = new Schema<IWorkspaceSettings>(
  {
    workspaceId: { type: String, required: true, unique: true },
    defaultHourlyRate: {
      type: Number,
      required: true,
      default: DEFAULT_WORKSPACE_SETTINGS.defaultHourlyRate,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: DEFAULT_WORKSPACE_SETTINGS.currency,
    },
    weekStartsOn: {
      type: Number,
      enum: [0, 1],
      required: true,
      default: DEFAULT_WORKSPACE_SETTINGS.weekStartsOn,
    },
  },
  { timestamps: true },
);

export const WorkspaceSettingsModel = mongoose.model<IWorkspaceSettings>(
  "WorkspaceSettings",
  workspaceSettingsSchema,
);

// ── user preferences ─────────────────────────────────────────────────

export interface IUserPreferences extends Document {
  userId: string;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  /** Absent on documents written before the theme was synced. */
  theme?: ThemePreference | null;
  /** Absent on documents written before the interface was localised. */
  locale?: LocalePreference | null;
  /** Absent on documents written before idle detection existed. */
  idle?: IdleSettings | null;
  /** Absent on documents written before the runaway guard existed. */
  maxDuration?: MaxDurationSettings | null;
  createdAt: Date;
  updatedAt: Date;
}

const idleSchema = new Schema<IdleSettings>(
  {
    enabled: { type: Boolean, required: true, default: DEFAULT_IDLE.enabled },
    thresholdMinutes: {
      type: Number,
      required: true,
      default: DEFAULT_IDLE.thresholdMinutes,
      min: MIN_IDLE_THRESHOLD_MINUTES,
      max: MAX_IDLE_THRESHOLD_MINUTES,
    },
    behavior: {
      type: String,
      // Must stay in lockstep with IdleBehavior; driving it off the shared
      // list is what guarantees it does.
      enum: [...IDLE_BEHAVIORS],
      required: true,
      default: DEFAULT_IDLE.behavior,
    },
    lockIsImmediate: {
      type: Boolean,
      required: true,
      default: DEFAULT_IDLE.lockIsImmediate,
    },
  },
  { _id: false },
);

const maxDurationSchema = new Schema<MaxDurationSettings>(
  {
    // No `min` beyond 0: 0 IS the off switch, so the bounds that reject a
    // half-hour maximum live in the zod schema, where a rejection can say why.
    maxHours: {
      type: Number,
      required: true,
      default: DEFAULT_MAX_DURATION.maxHours,
      min: 0,
    },
    behavior: {
      type: String,
      // Driven off the shared list, so a new behaviour cannot be accepted by
      // the type and silently rejected by Mongoose.
      enum: [...RUNAWAY_BEHAVIORS],
      required: true,
      default: DEFAULT_MAX_DURATION.behavior,
    },
  },
  { _id: false },
);

const userPreferencesSchema = new Schema<IUserPreferences>(
  {
    userId: { type: String, required: true, unique: true },
    timeFormat: {
      type: String,
      enum: ["12h", "24h"],
      required: true,
      default: DEFAULT_USER_PREFERENCES.timeFormat,
    },
    durationFormat: {
      type: String,
      enum: ["hms", "decimal"],
      required: true,
      default: DEFAULT_USER_PREFERENCES.durationFormat,
    },
    // NOT `required`: every preferences document written before the theme was
    // stored here has no such field, and a required one would fail validation
    // on each of them the next time it was saved. The read below defaults it.
    theme: {
      type: String,
      enum: ["light", "dark", "system"],
      default: DEFAULT_USER_PREFERENCES.theme,
    },
    // NOT `required`, exactly like `theme` above: documents written before
    // localisation have no such field.
    locale: {
      type: String,
      enum: [...LOCALE_PREFERENCES],
      default: DEFAULT_USER_PREFERENCES.locale,
    },
    idle: {
      type: idleSchema,
      required: true,
      default: (): IdleSettings => ({ ...DEFAULT_IDLE }),
    },
    maxDuration: {
      type: maxDurationSchema,
      required: true,
      default: (): MaxDurationSettings => ({ ...DEFAULT_MAX_DURATION }),
    },
  },
  { timestamps: true },
);

export const UserPreferencesModel = mongoose.model<IUserPreferences>(
  "UserPreferences",
  userPreferencesSchema,
);

// ── reads ────────────────────────────────────────────────────────────

/**
 * Workspace money/calendar config, seeded on first use.
 *
 * Every rate and currency snapshot in the app funnels through this, so it is
 * scoped by workspace and never by caller: two members stopping a timer in the
 * same workspace must snapshot the same currency.
 */
export async function getOrCreateWorkspaceSettings(
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const existing = await WorkspaceSettingsModel.findOne({ workspaceId }).lean();
  if (existing) {
    return {
      workspaceId,
      defaultHourlyRate: existing.defaultHourlyRate,
      currency: existing.currency,
      weekStartsOn: existing.weekStartsOn,
    };
  }

  await WorkspaceSettingsModel.updateOne(
    { workspaceId },
    { $setOnInsert: { workspaceId, ...DEFAULT_WORKSPACE_SETTINGS } },
    { upsert: true },
  );

  const created = await WorkspaceSettingsModel.findOne({ workspaceId }).lean();
  return created
    ? {
        workspaceId,
        defaultHourlyRate: created.defaultHourlyRate,
        currency: created.currency,
        weekStartsOn: created.weekStartsOn,
      }
    : { workspaceId, ...DEFAULT_WORKSPACE_SETTINGS };
}

/** A person's display preferences, seeded on first use. */
export async function getOrCreateUserPreferences(
  userId: string,
): Promise<UserPreferences> {
  const existing = await UserPreferencesModel.findOne({ userId }).lean();
  if (existing) {
    return {
      userId,
      timeFormat: existing.timeFormat,
      durationFormat: existing.durationFormat,
      // A document written before the theme was synced has none; "system" is
      // what such a client was already doing on its own.
      theme: existing.theme ?? DEFAULT_USER_PREFERENCES.theme,
      locale: existing.locale ?? DEFAULT_USER_PREFERENCES.locale,
      // A preferences document written before idle detection existed has no
      // `idle` sub-document; fall back field by field rather than dropping it.
      idle: {
        enabled: existing.idle?.enabled ?? DEFAULT_IDLE.enabled,
        thresholdMinutes:
          existing.idle?.thresholdMinutes ?? DEFAULT_IDLE.thresholdMinutes,
        behavior: existing.idle?.behavior ?? DEFAULT_IDLE.behavior,
        lockIsImmediate:
          existing.idle?.lockIsImmediate ?? DEFAULT_IDLE.lockIsImmediate,
      },
      // Same story: a document written before the guard existed has no
      // sub-document, and the guard reads `maxHours` as a number.
      maxDuration: {
        maxHours: existing.maxDuration?.maxHours ?? DEFAULT_MAX_DURATION.maxHours,
        behavior:
          existing.maxDuration?.behavior ?? DEFAULT_MAX_DURATION.behavior,
      },
    };
  }

  await UserPreferencesModel.updateOne(
    { userId },
    { $setOnInsert: { userId, ...DEFAULT_USER_PREFERENCES } },
    { upsert: true },
  );

  const created = await UserPreferencesModel.findOne({ userId }).lean();
  return created
    ? {
        userId,
        timeFormat: created.timeFormat,
        durationFormat: created.durationFormat,
        theme: created.theme ?? DEFAULT_USER_PREFERENCES.theme,
        locale: created.locale ?? DEFAULT_USER_PREFERENCES.locale,
        idle: { ...DEFAULT_IDLE, ...(created.idle ?? {}) },
        maxDuration: {
          ...DEFAULT_MAX_DURATION,
          ...(created.maxDuration ?? {}),
        },
      }
    : {
        userId,
        ...DEFAULT_USER_PREFERENCES,
        idle: { ...DEFAULT_IDLE },
        maxDuration: { ...DEFAULT_MAX_DURATION },
      };
}

/** The two records above, merged — exactly what `settings.get` returns. */
export async function getResolvedSettings(
  workspaceId: string,
  userId: string,
): Promise<ResolvedSettings> {
  const [workspace, user] = await Promise.all([
    getOrCreateWorkspaceSettings(workspaceId),
    getOrCreateUserPreferences(userId),
  ]);

  return {
    workspaceId: workspace.workspaceId,
    userId: user.userId,
    defaultHourlyRate: workspace.defaultHourlyRate,
    currency: workspace.currency,
    weekStartsOn: workspace.weekStartsOn,
    timeFormat: user.timeFormat,
    durationFormat: user.durationFormat,
    theme: user.theme,
    locale: user.locale,
    idle: user.idle,
    maxDuration: user.maxDuration,
  };
}
