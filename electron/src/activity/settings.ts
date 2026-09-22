/*
 * The capture switches. Device preferences, in `userData/activity/state.json`:
 * whether this computer records which app is in front is a decision about
 * this computer, so they outlive a sign-out. Capture is OFF until somebody
 * turns it on — nothing in this directory ever turns it on by itself.
 */

import type { DesktopActivitySettings } from "../../../packages/shared/src/desktop-bridge.ts";
import { toActivityPattern } from "./keys.ts";

export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;
/** How many "Never record" patterns are kept. */
export const MAX_EXCLUDED_APPS = 200;

export const DEFAULT_ACTIVITY_SETTINGS: DesktopActivitySettings = {
  enabled: false,
  storeTitles: false,
  excludedApps: [],
  retentionDays: DEFAULT_RETENTION_DAYS,
};

export function clampRetentionDays(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(value)))
    : DEFAULT_RETENTION_DAYS;
}

/** Key-shaped (`toActivityPattern`), de-duplicated patterns; empty and over-long ones dropped. */
export function cleanAppList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length > 200) continue;
    const pattern = toActivityPattern(value);
    if (pattern !== "" && !out.includes(pattern)) out.push(pattern);
    if (out.length >= MAX_EXCLUDED_APPS) break;
  }
  return out;
}

/** Narrow whatever is stored; anything unreadable falls back to the default. */
export function parseActivitySettings(value: unknown): DesktopActivitySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_ACTIVITY_SETTINGS };
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    storeTitles: record.storeTitles === true,
    excludedApps: Array.isArray(record.excludedApps) ? cleanAppList(record.excludedApps) : [],
    retentionDays:
      typeof record.retentionDays === "number" ? clampRetentionDays(record.retentionDays) : DEFAULT_RETENTION_DAYS,
  };
}

/** `<userId>:<workspaceId>`, the key every stored row carries. */
export function activityScopeOf(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

/** The prefix every scope of one account starts with. */
export function accountPrefixOf(userId: string): string {
  return `${userId}:`;
}
