/**
 * The activity capture switches, and whose activity is being captured.
 *
 * Both in `chrome.storage.local`, which is small and synchronous-feeling, and
 * neither synced: whether this browser watches its tabs is a decision about
 * this browser. Capture is OFF until somebody turns it on, and turning it on
 * also has to be granted the optional `tabs` permission — the popup asks for
 * it, because `chrome.permissions.request` only works from a user gesture.
 */
import { normalizeHostPattern } from "@starter/core/activity/index";
import { chromeStorage, localStorageArea } from "../../lib/chrome-storage";

export const ACTIVITY_SETTINGS_KEY = "trackyourtime.activity.settings";
export const ACTIVITY_SCOPE_KEY = "trackyourtime.activity.scope";

export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;

/** The optional permission capture depends on. */
export const CAPTURE_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ["tabs"],
};

export type ActivitySettings = {
  enabled: boolean;
  /** Page titles are more revealing than hostnames, so they are their own opt-in. */
  storeTitles: boolean;
  /** Host globs that are never recorded. */
  excludedHosts: string[];
  retentionDays: number;
};

export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = {
  enabled: false,
  storeTitles: false,
  excludedHosts: [],
  retentionDays: DEFAULT_RETENTION_DAYS,
};

const store = (): ReturnType<typeof chromeStorage> => chromeStorage(localStorageArea());

export const clampRetentionDays = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(value)))
    : DEFAULT_RETENTION_DAYS;

/** Normalised, de-duplicated host patterns, empty ones dropped. */
export const cleanHostList = (hosts: readonly unknown[]): string[] => {
  const out: string[] = [];
  for (const host of hosts) {
    if (typeof host !== "string") continue;
    const pattern = normalizeHostPattern(host);
    if (pattern !== "" && !out.includes(pattern)) out.push(pattern);
  }
  return out;
};

/** Narrow whatever is stored; anything unreadable falls back to the defaults. */
export const parseActivitySettings = (value: unknown): ActivitySettings => {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_ACTIVITY_SETTINGS };
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    storeTitles: record.storeTitles === true,
    excludedHosts: Array.isArray(record.excludedHosts) ? cleanHostList(record.excludedHosts) : [],
    retentionDays:
      typeof record.retentionDays === "number"
        ? clampRetentionDays(record.retentionDays)
        : DEFAULT_RETENTION_DAYS,
  };
};

export async function loadActivitySettings(): Promise<ActivitySettings> {
  const raw = await store().getItem(ACTIVITY_SETTINGS_KEY);
  if (raw === null) return { ...DEFAULT_ACTIVITY_SETTINGS };
  try {
    return parseActivitySettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_ACTIVITY_SETTINGS };
  }
}

export async function saveActivitySettings(
  patch: Partial<ActivitySettings>,
): Promise<ActivitySettings> {
  const current = await loadActivitySettings();
  const next = parseActivitySettings({ ...current, ...patch });
  await store().setItem(ACTIVITY_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** Whether the optional permission is currently granted. */
export async function capturePermitted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(CAPTURE_PERMISSIONS);
  } catch {
    return false;
  }
}

/** `<userId>:<workspaceId>`, the key every stored row carries. */
export const activityScopeOf = (userId: string, workspaceId: string): string =>
  `${userId}:${workspaceId}`;

export async function loadActivityScope(): Promise<string | null> {
  return store().getItem(ACTIVITY_SCOPE_KEY);
}

export async function saveActivityScope(scope: string): Promise<void> {
  await store().setItem(ACTIVITY_SCOPE_KEY, scope);
}

export async function clearActivityScope(): Promise<void> {
  await store().removeItem(ACTIVITY_SCOPE_KEY);
}
