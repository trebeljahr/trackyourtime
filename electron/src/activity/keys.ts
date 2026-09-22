/*
 * What an application is called in stored activity.
 *
 * A key is what time is attributed to and what "Never record" and filing rules
 * match against, through core's host globs. Those globs were written for
 * hostnames: `normalizeHostPattern` cuts at the first `/` and drops a trailing
 * `:<digits>`, so an exe path or a WM_CLASS with a colon in it would be matched
 * against half of itself. `toActivityKey` removes both characters (and `\`,
 * and whitespace runs), which is what lets `com.jetbrains.*` work unchanged.
 */

/** The longest key or name kept. */
export const ACTIVITY_KEY_MAX_LENGTH = 200;

export function toActivityKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[/:\\\s]+/g, "-")
    .slice(0, ACTIVITY_KEY_MAX_LENGTH);
}

/**
 * A "Never record" or filing-rule pattern, in the same shape as the keys it
 * is matched against. A typed `Track Your Time.exe` must become
 * `track-your-time.exe`, as the key does; kept as core's host pattern it would
 * keep its spaces and never match anything. `*` survives, so globs still work.
 */
export function toActivityPattern(raw: string): string {
  return toActivityKey(raw).replace(/\.$/, "");
}

/**
 * Never recorded, whatever the settings say: this app itself (time spent in
 * the tracker is not work to suggest), and the lock screen and screen saver on
 * each OS, which are the machine standing in for nobody.
 */
export const BUILT_IN_NEVER_RECORD: readonly string[] = [
  "com.trebeljahr.trackyourtime",
  "track-your-time.exe",
  "trackyourtime",
  "trackyourtime.exe",
  "com.apple.loginwindow",
  "com.apple.screensaver.engine",
  "com.apple.screensaver",
  "lockapp.exe",
  "logonui.exe",
];

/** What a source saw in front, before this app's own rules are applied. */
export interface FrontmostTarget {
  /** Bundle id, exe basename or WM_CLASS class, as the OS spells it. */
  key: string;
  /** A name a person recognises. */
  name: string;
  /** The window title, only ever read where titles are on. */
  title?: string;
  pid?: number;
}

/** A target this app may record, keyed and trimmed. */
export interface DescribedTarget {
  key: string;
  name: string;
  label?: string;
}

export function isBuiltInNeverRecord(key: string, pid: number | undefined, selfPid: number): boolean {
  if (pid !== undefined && pid === selfPid) return true;
  return BUILT_IN_NEVER_RECORD.includes(key);
}

export function cleanName(name: string, fallback: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, ACTIVITY_KEY_MAX_LENGTH);
  return trimmed === "" ? fallback : trimmed;
}
