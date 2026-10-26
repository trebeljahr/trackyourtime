import { z } from "zod";
import { idleSettingsSchema, localePreferenceSchema, maxDurationSettingsSchema } from "./schemas.js";
import { DEFAULT_IDLE_SETTINGS } from "./idle.js";
import { DEFAULT_MAX_DURATION_SETTINGS } from "./runaway.js";
import type { IdleSettings, MaxDurationSettings, UserPreferences } from "./types.js";
/** Existing account display/idle preferences, separate from workspace money.
 * This schema cannot carry a workspace rate, currency or private record. */
export const displayPreferencesSchema = z.object({
  userId: z.string().min(1).max(100), timeFormat: z.enum(["12h", "24h"]), durationFormat: z.enum(["hms", "decimal"]), theme: z.enum(["light", "dark", "system"]), locale: localePreferenceSchema,
  idle: idleSettingsSchema.strict(), maxDuration: maxDurationSettingsSchema.extend({ emailReminder: z.boolean() }).strict(),
}).strict();
type StoredPreferences = { [P in "timeFormat" | "durationFormat" | "theme" | "locale"]?: UserPreferences[P] | null } & { idle?: Partial<IdleSettings> | null; maxDuration?: Partial<MaxDurationSettings> | null };
/** Read-only legacy defaults. Missing rows are not created by this function. */
export function normalizeDisplayPreferences(userId: string, source?: StoredPreferences | null): UserPreferences {
  const idle = source?.idle, maximum = source?.maxDuration;
  return displayPreferencesSchema.parse({ userId, timeFormat: source?.timeFormat ?? "24h", durationFormat: source?.durationFormat ?? "hms", theme: source?.theme ?? "system", locale: source?.locale ?? "system",
    idle: { enabled: idle?.enabled ?? DEFAULT_IDLE_SETTINGS.enabled, thresholdMinutes: idle?.thresholdMinutes ?? DEFAULT_IDLE_SETTINGS.thresholdMinutes, behavior: idle?.behavior ?? DEFAULT_IDLE_SETTINGS.behavior, lockIsImmediate: idle?.lockIsImmediate ?? DEFAULT_IDLE_SETTINGS.lockIsImmediate },
    maxDuration: { maxHours: maximum?.maxHours ?? DEFAULT_MAX_DURATION_SETTINGS.maxHours, behavior: maximum?.behavior ?? DEFAULT_MAX_DURATION_SETTINGS.behavior, emailReminder: maximum?.emailReminder ?? DEFAULT_MAX_DURATION_SETTINGS.emailReminder },
  });
}
