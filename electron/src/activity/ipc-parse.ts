/*
 * Every activity IPC payload, narrowed before it reaches the store.
 *
 * `handle()` (ipc.ts) already refuses a sender outside the app's own origin;
 * this is the second half — a renderer bug, or a page that should never have
 * had the bridge, cannot write an unbounded array, a NaN or a scope with no
 * user in it. Each parser answers the value or null; a null is answered with
 * a refusal, never a throw across IPC.
 */

import type {
  DesktopActivityInterval,
  DesktopActivityRule,
  DesktopActivitySettings,
  DesktopAutopilotHistoryEntry,
  DesktopAutopilotRunning,
} from "../../../packages/shared/src/desktop-bridge.ts";
import { toActivityPattern } from "./keys.ts";
import { clampRetentionDays, cleanAppList, cleanAutopilotStartMinutes } from "./settings.ts";

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
  if (typeof value.autopilot === "boolean") patch.autopilot = value.autopilot;
  if (finite(value.autopilotStartMinutes)) patch.autopilotStartMinutes = cleanAutopilotStartMinutes(value.autopilotStartMinutes);
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
  const pattern = toActivityPattern(value.pattern);
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

/** How many entries one `learn` may carry: two weeks of a very busy person. */
export const MAX_HISTORY_ENTRIES = 3000;
/** A token is a UUID; a log id too. */
export const MAX_TOKEN_LENGTH = 64;
/** A filing key is JSON of a description and two ids. */
export const MAX_FILING_KEY_LENGTH = MAX_DESCRIPTION_LENGTH * 2 + MAX_ID_LENGTH * 2 + 16;

const isNullableId = (value: unknown): value is string | null => value === null || isId(value);

const isDescription = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_DESCRIPTION_LENGTH;

function parseRunning(value: unknown): DesktopAutopilotRunning | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !finite(value.start) || !isDescription(value.description)) return undefined;
  if (!isNullableId(value.projectId) || !isNullableId(value.taskId)) return undefined;
  return { start: value.start, description: value.description, projectId: value.projectId, taskId: value.taskId };
}

export function parseAutopilotPlanInput(
  value: unknown,
): { running: DesktopAutopilotRunning | null; tracked: DesktopActivityInterval[] } | null {
  if (!isRecord(value)) return null;
  const running = parseRunning(value.running);
  if (running === undefined) return null;
  const tracked = parseTracked(value.tracked);
  return tracked === null ? null : { running, tracked };
}

export function parseAutopilotHistory(value: unknown): DesktopAutopilotHistoryEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_ENTRIES) return null;
  const out: DesktopAutopilotHistoryEntry[] = [];
  for (const item of value) {
    const span = parseInterval(item);
    if (span === null || !isRecord(item) || !isDescription(item.description)) return null;
    if (!isNullableId(item.projectId) || !isNullableId(item.taskId) || typeof item.billable !== "boolean") return null;
    if (!Array.isArray(item.tagIds) || item.tagIds.length > MAX_TAG_IDS || !item.tagIds.every(isId)) return null;
    out.push({
      ...span,
      description: item.description,
      projectId: item.projectId,
      taskId: item.taskId,
      tagIds: [...(item.tagIds as string[])],
      billable: item.billable,
    });
  }
  return out;
}

const isToken = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= MAX_TOKEN_LENGTH;

export function parseAutopilotApplied(value: unknown): {
  token: string;
  ok: boolean;
  written?: { description: string; projectId: string | null; taskId: string | null };
} | null {
  if (!isRecord(value) || !isToken(value.token) || typeof value.ok !== "boolean") return null;
  if (value.written === undefined) return { token: value.token, ok: value.ok };
  const written = value.written;
  if (!isRecord(written) || !isDescription(written.description)) return null;
  if (!isNullableId(written.projectId) || !isNullableId(written.taskId)) return null;
  return {
    token: value.token,
    ok: value.ok,
    written: { description: written.description, projectId: written.projectId, taskId: written.taskId },
  };
}

export function parseAutopilotHold(
  value: unknown,
): { filingKey?: string; appKey?: string; dismiss?: DesktopActivityInterval; logId?: string } | null {
  if (!isRecord(value)) return null;
  const out: { filingKey?: string; appKey?: string; dismiss?: DesktopActivityInterval; logId?: string } = {};
  if (value.filingKey !== undefined) {
    if (typeof value.filingKey !== "string" || value.filingKey === "" || value.filingKey.length > MAX_FILING_KEY_LENGTH) {
      return null;
    }
    out.filingKey = value.filingKey;
  }
  if (value.appKey !== undefined) {
    if (typeof value.appKey !== "string" || value.appKey.length > MAX_PATTERN_LENGTH) return null;
    const key = toActivityPattern(value.appKey);
    if (key === "") return null;
    out.appKey = key;
  }
  if (value.dismiss !== undefined) {
    const span = parseInterval(value.dismiss);
    if (span === null || span.end - span.start > MAX_RANGE_MS) return null;
    out.dismiss = span;
  }
  if (value.logId !== undefined) {
    if (!isToken(value.logId)) return null;
    out.logId = value.logId;
  }
  return out;
}
