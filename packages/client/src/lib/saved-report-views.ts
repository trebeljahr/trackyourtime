import { dayKeyInZone, type WeekStart } from "@starter/shared";
import type { KeyValueStorage } from "@starter/core";
import { DATE_RANGE_PRESETS, rangeForPreset, type DateRange, type DateRangePresetId, type DateRangePickerPresetId } from "@/components/date-range-picker";
import { preferencesStorage, shouldUseNativeStorage } from "@/mobile/preferences-storage";

export const REPORT_PRESET_PARAM = "preset";
export const SAVED_REPORT_PARAMS = ["from", "to", "preset", "projects", "clients", "tasks", "tags", "members", "billable", "q", "group", "sort", "dir", "view"] as const;
export type ReportStorageIdentity = { userId: string; server: string; workspaceId: string };
export type SavedReportView = { id: string; name: string; query: string };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateViews(raw: unknown): SavedReportView[] {
  if (!Array.isArray(raw) || raw.length > 50) throw new Error("Invalid saved report views");
  const views = raw.map((value: unknown): SavedReportView => {
    if (!object(value) || Object.keys(value).some((key) => !["id", "name", "query"].includes(key)) ||
      typeof value.id !== "string" || !value.id || value.id.length > 80 ||
      typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80 ||
      typeof value.query !== "string" || value.query.length > 12000) throw new Error("Invalid saved report view");
    return { id: value.id, name: value.name.trim(), query: value.query };
  });
  if (new Set(views.map((view) => view.id)).size !== views.length) throw new Error("Duplicate saved report ids");
  return views;
}

export function reportStorageKey(identity: ReportStorageIdentity): string {
  if (!identity.userId || !identity.workspaceId) throw new Error("Missing report storage identity");
  const server = new URL(identity.server).origin;
  return `trackyourtime.report-views.v1:${encodeURIComponent(JSON.stringify([server, identity.userId, identity.workspaceId]))}`;
}

export function parseReportPreset(raw: string | null): DateRangePickerPresetId | null {
  if (raw === "allTime") return "allTime";
  return DATE_RANGE_PRESETS.find(({ id }) => id === raw)?.id ?? null;
}

/** Resolve the current calendar day in the viewer's zone, never in the server's. */
export function relativeReportRange(preset: DateRangePresetId, weekStartsOn: WeekStart, now: Date = new Date(), timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): DateRange {
  const [year, month, day] = dayKeyInZone(now.getTime(), timeZone).split("-").map(Number);
  return rangeForPreset(preset, weekStartsOn, new Date(year!, month! - 1, day!, 12));
}

/** Only existing report filter keys are stored; custom dates are never guessed as a preset. */
export function savedReportQuery(query: string, range: DateRange): string {
  const source = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const key of SAVED_REPORT_PARAMS) {
    const value = source.get(key);
    if (value !== null) kept.set(key, value);
  }
  const preset = parseReportPreset(source.get(REPORT_PRESET_PARAM)) ?? (source.get("from") === null && source.get("to") === null ? "thisWeek" : null);
  if (preset) {
    kept.set(REPORT_PRESET_PARAM, preset);
    kept.delete("from"); kept.delete("to");
  } else {
    kept.delete(REPORT_PRESET_PARAM);
    kept.set("from", range.from); kept.set("to", range.to);
  }
  return kept.toString();
}

export function resolveSavedReportQuery(view: SavedReportView, weekStartsOn: WeekStart, now = new Date(), timeZone?: string, allTime: DateRange | null = null): string {
  const params = new URLSearchParams(view.query);
  const preset = parseReportPreset(params.get(REPORT_PRESET_PARAM));
  if (preset) {
    const range = preset === "allTime" ? allTime : relativeReportRange(preset, weekStartsOn, now, timeZone);
    if (!range) throw new Error("Tracked range unavailable");
    params.set("from", range.from); params.set("to", range.to);
  }
  return params.toString();
}

export function savedReportStorage(): KeyValueStorage {
  if (shouldUseNativeStorage()) return preferencesStorage({ strict: true });
  // webStorage deliberately swallows errors; a saved view must report a failed save.
  return {
    getItem: async (key) => window.localStorage.getItem(key),
    setItem: async (key, value) => window.localStorage.setItem(key, value),
    removeItem: async (key) => window.localStorage.removeItem(key),
  };
}

/** Reads fail closed. A failed/corrupt read must never overwrite earlier views. */
export function createSavedReportStore(identity: ReportStorageIdentity, storage: KeyValueStorage): {
  load: () => Promise<SavedReportView[]>;
  write: (views: readonly SavedReportView[]) => Promise<void>;
} {
  const key = reportStorageKey(identity);
  return {
    load: async () => {
      const raw = await storage.getItem(key);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!object(parsed) || parsed.version !== 1 || Object.keys(parsed).some((field) => !["version", "identity", "views"].includes(field))) {
        throw new Error("Invalid saved report record");
      }
      if (parsed.identity !== key) throw new Error("Report storage identity mismatch");
      return validateViews(parsed.views);
    },
    write: async (views) => {
      const value = { version: 1, identity: key, views: validateViews(views) };
      await storage.setItem(key, JSON.stringify(value));
    },
  };
}
