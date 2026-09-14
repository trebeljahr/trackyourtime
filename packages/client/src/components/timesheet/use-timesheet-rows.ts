"use client";

import * as React from "react";
import { timesheetRowKey } from "@starter/shared";

import {
  getActiveWorkspaceId,
  subscribeActiveWorkspace,
} from "@/lib/active-workspace";

/**
 * Rows the user added to the grid, kept locally.
 *
 * A pinned row is a statement of intent — "I expect to book time to this" —
 * not tracked data, so it does not belong in the entry model and it does not
 * need to reach the server: the row appears the moment the first hours are
 * typed into it anyway, because entries imply their own rows. Keeping it in
 * localStorage means adding a row costs nothing and cannot fail, and a
 * timesheet whose rows are stable week to week is the whole point of one.
 *
 * Exposed through `useSyncExternalStore` rather than an effect that seeds
 * state: localStorage does not exist during the static export's prerender, so
 * the server snapshot is empty and the store swaps in the real rows after
 * hydration without a cascading render.
 *
 * **Per workspace.** A pinned row names a project and task by id, and those
 * ids belong to one workspace. One list for the whole device showed
 * workspace A's pinned rows in B as rows for projects B does not have. The
 * key carries the active workspace, and the store follows a switch.
 */

export type PinnedRow = {
  projectId: string | null;
  taskId: string | null;
};

/** The pre-workspace key. Adopted, once, by the first workspace to read. */
const LEGACY_STORAGE_KEY = "trackyourtime.timesheet-rows";

const storageKey = (workspaceId: string | null): string =>
  workspaceId === null
    ? LEGACY_STORAGE_KEY
    : `${LEGACY_STORAGE_KEY}:${workspaceId}`;

/** Stable identity, so a snapshot that has not changed re-renders nothing. */
const EMPTY: PinnedRow[] = [];

const readStored = (workspaceId: string | null): PinnedRow[] => {
  if (typeof window === "undefined") return EMPTY;
  try {
    const key = storageKey(workspaceId);
    let raw = window.localStorage.getItem(key);
    // Rows pinned before the key carried a workspace were all pinned in the
    // only workspace there was, which is the one resolved first.
    if (raw === null && key !== LEGACY_STORAGE_KEY) {
      raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw !== null) {
        window.localStorage.setItem(key, raw);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.flatMap((item): PinnedRow[] => {
      if (typeof item !== "object" || item === null) return [];
      const row = item as { projectId?: unknown; taskId?: unknown };
      return [
        {
          projectId: typeof row.projectId === "string" ? row.projectId : null,
          taskId: typeof row.taskId === "string" ? row.taskId : null,
        },
      ];
    });
  } catch {
    // Privacy mode, a quota error, or a row written by an older build.
    return EMPTY;
  }
};

const writeStored = (workspaceId: string | null, rows: PinnedRow[]): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(rows));
  } catch {
    // Not being able to remember the row is no reason to refuse adding it.
  }
};

// ── the store ────────────────────────────────────────────────────────

let cached: { workspaceId: string | null; rows: PinnedRow[] } | null = null;
const listeners = new Set<() => void>();

/** Re-read whenever the active workspace is not the one the cache is for. */
const getSnapshot = (): PinnedRow[] => {
  const workspaceId = getActiveWorkspaceId();
  if (cached === null || cached.workspaceId !== workspaceId) {
    cached = { workspaceId, rows: readStored(workspaceId) };
  }
  return cached.rows;
};

const getServerSnapshot = (): PinnedRow[] => EMPTY;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  // A switch changes which list `getSnapshot` answers with.
  const unsubscribeWorkspace = subscribeActiveWorkspace(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeWorkspace();
  };
};

const commit = (rows: PinnedRow[]): void => {
  const workspaceId = getActiveWorkspaceId();
  cached = { workspaceId, rows };
  writeStored(workspaceId, rows);
  for (const listener of listeners) listener();
};

/** Test seam. */
export const __resetTimesheetRowsForTests = (): void => {
  cached = null;
};

const sameRow = (a: PinnedRow, b: PinnedRow): boolean =>
  timesheetRowKey(a.projectId, a.taskId) === timesheetRowKey(b.projectId, b.taskId);

export type TimesheetRowsState = {
  rows: PinnedRow[];
  pin: (row: PinnedRow) => void;
  unpin: (row: PinnedRow) => void;
  isPinned: (row: PinnedRow) => boolean;
};

export const useTimesheetRows = (): TimesheetRowsState => {
  const rows = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const pin = React.useCallback((row: PinnedRow): void => {
    const current = getSnapshot();
    if (current.some((candidate) => sameRow(candidate, row))) return;
    commit([...current, row]);
  }, []);

  const unpin = React.useCallback((row: PinnedRow): void => {
    const current = getSnapshot();
    const next = current.filter((candidate) => !sameRow(candidate, row));
    if (next.length !== current.length) commit(next);
  }, []);

  const isPinned = React.useCallback(
    (row: PinnedRow): boolean =>
      rows.some((candidate) => sameRow(candidate, row)),
    [rows]
  );

  return { rows, pin, unpin, isPinned };
};
