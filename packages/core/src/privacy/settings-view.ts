import { z } from "zod";
import { displayPreferencesSchema, type ResolvedSettings } from "@starter/shared";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
const id = z.string().min(1).max(100), rate = z.number().finite().nonnegative();
/** Account rendering preferences never supply workspace money/calendar facts.
 * Those facts and the caller's own rate come only from the decrypted replica. */
export function privateSettingsQuery(options: PrivateViewOptions & { input: unknown; preferences: unknown }): ResolvedSettings {
  const { scope } = options, { check, ofKind, value, paired } = privateViewSource(options);
  const input = z.object({ workspaceId: id.optional() }).strict().parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private settings filter belongs to another workspace");
  const preferences = displayPreferencesSchema.parse(options.preferences);
  if (preferences.userId !== scope.userId) throw new Error("Display preferences belong to another account");
  const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Private workspace settings are ambiguous");
  const workspace = settings.length ? z.object({ currency: z.string().regex(/^[A-Z]{3}$/), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }).parse(value(settings[0]!)) : { currency: "EUR", weekStartsOn: 1 as const };
  const defaultHourlyRate = settings.length ? rate.parse(paired(settings[0]!, "settingsMoney").defaultHourlyRate ?? 0) : 0;
  const members = ofKind("members").filter((row) => row.authorId === scope.userId);
  if (members.length !== 1 || value(members[0]!).userId !== scope.userId) throw new Error("Private settings need this account's original member record");
  const memberHourlyRate = rate.nullish().transform((value) => value ?? null).parse(paired(members[0]!, "memberMoney").hourlyRate);
  const result: ResolvedSettings = { ...preferences, workspaceId: scope.workspaceId, ...workspace, defaultHourlyRate, memberHourlyRate }; check(); return result;
}
