/*
 * Where captured activity lives: `userData/activity/`, on this computer only.
 *
 *   state.json                 settings, scope, rules, dismissals (atomic)
 *   open.json                  the open segment; absent when none is open
 *   segments/YYYY-MM-DD.jsonl  closed segments, one JSON line each, filed
 *                              under the UTC day of their start
 *
 * Plain files, directory 0700 and files 0600. Not encrypted: on Linux's
 * `basic_text` backend and under the headless mock keychain encryption would
 * be decoration, and the content is less sensitive than the session token.
 * Nothing here opens a connection; the only way activity leaves the device is
 * as an entry the person accepted, which the renderer creates.
 *
 * Every call is synchronous and small, and `install.ts` runs them one at a
 * time through its serial queue; the single-instance lock makes this process
 * the only writer.
 *
 * `state.json` carries `v`. A newer build's format locks the store: nothing is
 * written, moved or deleted, capture stays off, and Settings says why — the
 * same rule as the offline queue's envelope. An unreadable `state.json` is
 * copied aside before the defaults replace it.
 */

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ActivityInterval, ActivityRule } from "../../../packages/core/src/activity/index.ts";
import type { DesktopActivitySettings } from "../../../packages/shared/src/desktop-bridge.ts";
import type { OpenSegment, StoredSegment } from "./model.ts";
import { DEFAULT_ACTIVITY_SETTINGS, parseActivitySettings } from "./settings.ts";

export const ACTIVITY_FORMAT_VERSION = 1;
export const ACTIVITY_DIR = "activity";

const STATE_FILE = "state.json";
const OPEN_FILE = "open.json";
const SEGMENTS_DIR = "segments";
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
/** A line longer than this is not one this app wrote. */
const MAX_LINE_LENGTH = 64 * 1024;

export type StoreStatus = "ok" | "newer-format";

export interface StoredRule extends ActivityRule {
  scope: string;
  createdAt: number;
}

export interface StoredDismissal extends ActivityInterval {
  scope: string;
}

export interface ActivityStore {
  readonly status: StoreStatus;
  readonly dir: string;
  settings: () => DesktopActivitySettings;
  scope: () => string | null;
  /** Writes settings and scope together (one file). */
  saveState: (settings: DesktopActivitySettings, scope: string | null) => void;

  rules: (scope: string) => ActivityRule[];
  /** Replaces any rule of the scope with the same pattern. */
  putRule: (scope: string, rule: ActivityRule, createdAt: number) => void;
  deleteRule: (scope: string, id: string) => void;
  dismissals: (scope: string) => ActivityInterval[];
  addDismissal: (scope: string, span: ActivityInterval) => void;

  readOpen: () => OpenSegment | null;
  writeOpen: (open: OpenSegment | null) => void;

  append: (segment: StoredSegment) => void;
  /** The scope's segments overlapping `[from, to)`. */
  segments: (scope: string, from: number, to: number) => StoredSegment[];
  /** Every stored segment of the scope, oldest first. */
  allSegments: (scope: string) => StoredSegment[];
  /** Map every stored segment; null deletes it. Returns how many changed. */
  rewriteSegments: (map: (segment: StoredSegment) => StoredSegment | null) => number;
  /** Delete every segment, rule and dismissal whose scope does not start with `keepPrefix`. */
  sweepScopes: (keepPrefix: string) => void;
  /** Delete every segment, rule, dismissal and the open segment. */
  wipe: () => void;
  /** Delete what ended before the retention window. Returns how many segments went. */
  prune: (now: number, retentionDays: number) => number;

  /** Raw contents, for the headless test hook. */
  files: () => { state: unknown; open: unknown; segments: unknown[] };
}

interface StateFile {
  v: number;
  settings: DesktopActivitySettings;
  scope: string | null;
  rules: StoredRule[];
  dismissals: StoredDismissal[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

export function parseStoredSegment(value: unknown): StoredSegment | null {
  if (!isRecord(value)) return null;
  const { scope, start, end, key, name, label } = value;
  if (typeof scope !== "string" || typeof key !== "string" || key === "") return null;
  if (!finite(start) || !finite(end) || end < start) return null;
  if (!optionalString(label)) return null;
  return {
    scope,
    source: "desktop",
    start,
    end,
    key,
    name: typeof name === "string" && name !== "" ? name : key,
    ...(label !== undefined ? { label } : {}),
    afk: false,
  };
}

export function parseOpenSegment(value: unknown): OpenSegment | null {
  if (!isRecord(value)) return null;
  const { scope, key, name, label, start, lastSeen } = value;
  if (typeof scope !== "string" || typeof key !== "string" || key === "") return null;
  if (!finite(start) || !finite(lastSeen) || lastSeen < start) return null;
  if (!optionalString(label)) return null;
  return {
    scope,
    key,
    name: typeof name === "string" && name !== "" ? name : key,
    ...(label !== undefined ? { label } : {}),
    start,
    lastSeen,
  };
}

function parseRule(value: unknown): StoredRule | null {
  if (!isRecord(value)) return null;
  const { scope, id, pattern, description, projectId, taskId, tagIds, billable, createdAt } = value;
  if (typeof scope !== "string" || typeof id !== "string" || typeof pattern !== "string" || pattern === "") return null;
  const rule: StoredRule = { scope, id, pattern, createdAt: finite(createdAt) ? createdAt : 0 };
  if (typeof description === "string") rule.description = description;
  if (typeof projectId === "string" || projectId === null) rule.projectId = projectId;
  if (typeof taskId === "string" || taskId === null) rule.taskId = taskId;
  if (Array.isArray(tagIds)) rule.tagIds = tagIds.filter((tag): tag is string => typeof tag === "string");
  if (typeof billable === "boolean") rule.billable = billable;
  return rule;
}

function parseDismissal(value: unknown): StoredDismissal | null {
  if (!isRecord(value)) return null;
  const { scope, start, end } = value;
  if (typeof scope !== "string" || !finite(start) || !finite(end) || end <= start) return null;
  return { scope, start, end };
}

function defaultState(): StateFile {
  return { v: ACTIVITY_FORMAT_VERSION, settings: { ...DEFAULT_ACTIVITY_SETTINGS }, scope: null, rules: [], dismissals: [] };
}

export function dayFileOf(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 10)}.jsonl`;
}

function dayStartOf(file: string): number | null {
  const match = DAY_FILE.exec(file);
  if (match === null) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const withoutScope = (rule: StoredRule): ActivityRule => {
  const { scope: _scope, createdAt: _createdAt, ...rest } = rule;
  return rest;
};

export function createActivityStore(userData: string, clock: () => number = Date.now): ActivityStore {
  const dir = path.join(userData, ACTIVITY_DIR);
  const segmentsDir = path.join(dir, SEGMENTS_DIR);
  const statePath = path.join(dir, STATE_FILE);
  const openPath = path.join(dir, OPEN_FILE);

  let status: StoreStatus = "ok";
  let state = defaultState();

  const ensureDirs = (): void => {
    mkdirSync(segmentsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
      chmodSync(segmentsDir, 0o700);
    } catch {
      /* Windows: POSIX modes do not apply */
    }
  };

  const writeAtomic = (target: string, data: string): void => {
    const temp = `${target}.tmp`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, target);
  };

  // ── load state.json ────────────────────────────────────────────────
  let raw: string | null = null;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && finite(parsed.v) && parsed.v > ACTIVITY_FORMAT_VERSION) {
      // A newer build's folder: read what can be shown, touch nothing.
      status = "newer-format";
      state = { ...defaultState(), settings: { ...parseActivitySettings(parsed.settings), enabled: false } };
    } else if (isRecord(parsed) && (parsed.v === undefined || parsed.v === ACTIVITY_FORMAT_VERSION)) {
      state = {
        v: ACTIVITY_FORMAT_VERSION,
        settings: parseActivitySettings(parsed.settings),
        scope: typeof parsed.scope === "string" && parsed.scope !== "" ? parsed.scope : null,
        rules: Array.isArray(parsed.rules)
          ? parsed.rules.map(parseRule).filter((rule): rule is StoredRule => rule !== null)
          : [],
        dismissals: Array.isArray(parsed.dismissals)
          ? parsed.dismissals.map(parseDismissal).filter((d): d is StoredDismissal => d !== null)
          : [],
      };
    } else {
      // Unreadable: kept aside for whoever wants to look, then defaults.
      try {
        copyFileSync(statePath, `${statePath}.corrupt.${clock()}`);
      } catch {
        /* nothing to keep */
      }
    }
  }

  const locked = (): boolean => status !== "ok";

  const saveStateFile = (): void => {
    if (locked()) return;
    ensureDirs();
    writeAtomic(statePath, `${JSON.stringify(state)}\n`);
  };

  // ── segments ───────────────────────────────────────────────────────
  let cache: StoredSegment[] | null = null;

  const dayFiles = (): string[] => {
    try {
      return readdirSync(segmentsDir)
        .filter((file) => DAY_FILE.test(file))
        .sort();
    } catch {
      return [];
    }
  };

  const readDayFile = (file: string): StoredSegment[] => {
    let text: string;
    try {
      text = readFileSync(path.join(segmentsDir, file), "utf8");
    } catch {
      return [];
    }
    const out: StoredSegment[] = [];
    for (const line of text.split("\n")) {
      if (line === "" || line.length > MAX_LINE_LENGTH) continue;
      try {
        const segment = parseStoredSegment(JSON.parse(line) as unknown);
        if (segment !== null) out.push(segment);
      } catch {
        // A torn last line from a crash mid-append: skipped, never fatal.
      }
    }
    return out;
  };

  const loadAll = (): StoredSegment[] => {
    cache ??= dayFiles().flatMap(readDayFile);
    return cache;
  };

  const writeDayFile = (file: string, segments: StoredSegment[]): void => {
    const target = path.join(segmentsDir, file);
    if (segments.length === 0) {
      rmSync(target, { force: true });
      return;
    }
    writeAtomic(target, segments.map((segment) => `${JSON.stringify(segment)}\n`).join(""));
  };

  const rewriteFiles = (files: readonly string[], map: (segment: StoredSegment) => StoredSegment | null): number => {
    if (locked()) return 0;
    let changed = 0;
    for (const file of files) {
      const before = readDayFile(file);
      const after: StoredSegment[] = [];
      let fileChanged = false;
      for (const segment of before) {
        const next = map(segment);
        if (next !== segment) fileChanged = true;
        if (next !== null) after.push(next);
        if (next !== segment) changed += 1;
      }
      if (fileChanged) writeDayFile(file, after);
    }
    cache = null;
    return changed;
  };

  const store: ActivityStore = {
    get status() {
      return status;
    },
    dir,
    settings: () => ({ ...state.settings, excludedApps: [...state.settings.excludedApps] }),
    scope: () => state.scope,
    saveState: (settings, scope) => {
      if (locked()) return;
      state = { ...state, settings, scope };
      saveStateFile();
    },

    rules: (scope) => state.rules.filter((rule) => rule.scope === scope).map(withoutScope),
    putRule: (scope, rule, createdAt) => {
      if (locked()) return;
      state = {
        ...state,
        rules: [
          ...state.rules.filter((stored) => !(stored.scope === scope && (stored.pattern === rule.pattern || stored.id === rule.id))),
          { ...rule, scope, createdAt },
        ],
      };
      saveStateFile();
    },
    deleteRule: (scope, id) => {
      if (locked()) return;
      state = { ...state, rules: state.rules.filter((rule) => !(rule.scope === scope && rule.id === id)) };
      saveStateFile();
    },
    dismissals: (scope) =>
      state.dismissals.filter((d) => d.scope === scope).map(({ start, end }) => ({ start, end })),
    addDismissal: (scope, span) => {
      if (locked()) return;
      state = { ...state, dismissals: [...state.dismissals, { scope, start: span.start, end: span.end }] };
      saveStateFile();
    },

    readOpen: () => {
      if (locked()) return null;
      try {
        return parseOpenSegment(JSON.parse(readFileSync(openPath, "utf8")) as unknown);
      } catch {
        return null;
      }
    },
    writeOpen: (open) => {
      if (locked()) return;
      if (open === null) {
        rmSync(openPath, { force: true });
        return;
      }
      ensureDirs();
      writeAtomic(openPath, `${JSON.stringify(open)}\n`);
    },

    append: (segment) => {
      if (locked()) return;
      ensureDirs();
      appendFileSync(path.join(segmentsDir, dayFileOf(segment.start)), `${JSON.stringify(segment)}\n`, {
        mode: 0o600,
      });
      cache?.push(segment);
    },
    segments: (scope, from, to) =>
      loadAll().filter((segment) => segment.scope === scope && segment.end > from && segment.start < to),
    allSegments: (scope) => loadAll().filter((segment) => segment.scope === scope),
    rewriteSegments: (map) => rewriteFiles(dayFiles(), map),
    sweepScopes: (keepPrefix) => {
      if (locked()) return;
      rewriteFiles(dayFiles(), (segment) => (segment.scope.startsWith(keepPrefix) ? segment : null));
      state = {
        ...state,
        rules: state.rules.filter((rule) => rule.scope.startsWith(keepPrefix)),
        dismissals: state.dismissals.filter((d) => d.scope.startsWith(keepPrefix)),
      };
      saveStateFile();
    },
    wipe: () => {
      if (locked()) return;
      rmSync(segmentsDir, { recursive: true, force: true });
      rmSync(openPath, { force: true });
      cache = null;
      state = { ...state, rules: [], dismissals: [] };
      saveStateFile();
    },
    prune: (now, retentionDays) => {
      if (locked()) return 0;
      const cutoff = now - retentionDays * DAY_MS;
      // Only files that start before the cutoff can hold anything to prune.
      const older = dayFiles().filter((file) => (dayStartOf(file) ?? 0) < cutoff);
      const removed = rewriteFiles(older, (segment) => (segment.end < cutoff ? null : segment));
      const dismissals = state.dismissals.filter((d) => d.end >= cutoff);
      if (dismissals.length !== state.dismissals.length) {
        state = { ...state, dismissals };
        saveStateFile();
      }
      return removed;
    },

    files: () => {
      const readJson = (target: string): unknown => {
        try {
          return JSON.parse(readFileSync(target, "utf8")) as unknown;
        } catch {
          return null;
        }
      };
      return {
        state: readJson(statePath),
        open: readJson(openPath),
        segments: dayFiles().flatMap(readDayFile),
      };
    },
  };
  return store;
}
