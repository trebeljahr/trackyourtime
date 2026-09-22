/*
 * Every activity IPC payload, narrowed before it reaches the store.
 *
 * `handle()` (ipc.ts) already refuses a sender outside the app's own origin;
 * this is the second half — a renderer bug, or a page that should never have
 * had the bridge, cannot write an unbounded array, a NaN or a scope with no
 * user in it. Each parser answers the value or null; a null is answered with
 * a refusal, never a throw across IPC.
 */

import { normalizeHostPattern } from "../../../packages/core/src/activity/index.ts";
import type {
  DesktopActivityInterval,
  DesktopActivityRule,
  DesktopActivitySettings,
} from "../../../packages/shared/src/desktop-bridge.ts";
import { clampRetentionDays, cleanAppList } from "./settings.ts";

export const MAX_RANGE_MS = 8 * 86_400_000;
export const MAX_TRACKED_INTERVALS = 5000;
export const MAX_ID_LENGTH = 64;
export const MAX_PATTERN_LENGTH = 200;
/** The entry schema's own limits (`packages/shared/src/schemas.ts`). */
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_TAG_IDS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH;

export function parseSettingsPatch(value: unknown): Partial<DesktopActivitySettings> | null {
  if (!isRecord(value)) return null;
  const patch: Partial<DesktopActivitySettings> = {};
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (typeof value.storeTitles === "boolean") patch.storeTitles = value.storeTitles;
  if (Array.isArray(value.excludedApps)) patch.excludedApps = cleanAppList(value.excludedApps);
  if (finite(value.retentionDays)) patch.retentionDays = clampRetentionDays(value.retentionDays);
  return patch;
}

export function parseScope(value: unknown): { userId: string; workspaceId: string } | null {
  if (!isRecord(value) || !isId(value.userId) || !isId(value.workspaceId)) return null;
  // The scope is `<userId>:<workspaceId>`, and the account sweep matches `<userId>:`.
  if (value.userId.includes(":")) return null;
  return { userId: value.userId, workspaceId: value.workspaceId };
}

export function parseInterval(value: unknown): DesktopActivityInterval | null {
  if (!isRecord(value) || !finite(value.start) || !finite(value.end) || !(value.end > value.start)) return null;
  return { start: value.start, end: value.end };
}

function parseTracked(value: unknown): DesktopActivityInterval[] | null {
  if (!Array.isArray(value) || value.length > MAX_TRACKED_INTERVALS) return null;
  const out: DesktopActivityInterval[] = [];
  for (const item of value) {
    const interval = parseInterval(item);
    if (interval === null) return null;
    out.push(interval);
  }
  return out;
}

export function parseSuggestionsInput(
  value: unknown,
): { from: number; to: number; tracked: DesktopActivityInterval[] } | null {
  if (!isRecord(value) || !finite(value.from) || !finite(value.to)) return null;
  if (!(value.to > value.from) || value.to - value.from > MAX_RANGE_MS) return null;
  const tracked = parseTracked(value.tracked);
  return tracked === null ? null : { from: value.from, to: value.to, tracked };
}

export function parseCheckAcceptInput(
  value: unknown,
): { start: number; end: number; edited: boolean; tracked: DesktopActivityInterval[] } | null {
  if (!isRecord(value) || typeof value.edited !== "boolean") return null;
  const span = parseInterval(value);
  if (span === null || span.end - span.start > MAX_RANGE_MS) return null;
  const tracked = parseTracked(value.tracked);
  return tracked === null ? null : { ...span, edited: value.edited, tracked };
}

export function parseRuleInput(value: unknown): Omit<DesktopActivityRule, "id"> | null {
  if (!isRecord(value) || typeof value.pattern !== "string" || value.pattern.length > MAX_PATTERN_LENGTH) return null;
  const pattern = normalizeHostPattern(value.pattern);
  if (pattern === "") return null;
  const rule: Omit<DesktopActivityRule, "id"> = { pattern };
  if (value.description !== undefined) {
    if (typeof value.description !== "string" || value.description.length > MAX_DESCRIPTION_LENGTH) return null;
    rule.description = value.description;
  }
  for (const field of ["projectId", "taskId"] as const) {
    const id = value[field];
    if (id === undefined) continue;
    if (id !== null && !isId(id)) return null;
    rule[field] = id;
  }
  if (value.tagIds !== undefined) {
    if (!Array.isArray(value.tagIds) || value.tagIds.length > MAX_TAG_IDS || !value.tagIds.every(isId)) return null;
    rule.tagIds = [...new Set(value.tagIds as string[])];
  }
  if (value.billable !== undefined) {
    if (typeof value.billable !== "boolean") return null;
    rule.billable = value.billable;
  }
  return rule;
}

export function parseRuleId(value: unknown): string | null {
  return isId(value) ? value : null;
}
