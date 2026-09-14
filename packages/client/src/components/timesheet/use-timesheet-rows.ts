"use client";

import * as React from "react";
import { timesheetRowKey } from "@starter/shared";

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
 */

export type PinnedRow = {
  projectId: string | null;
  taskId: string | null;
};

const STORAGE_KEY = "trackyourtime.timesheet-rows";

/** Stable identity, so a snapshot that has not changed re-renders nothing. */
const EMPTY: PinnedRow[] = [];

const readStored = (): PinnedRow[] => {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

const writeStored = (rows: PinnedRow[]): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Not being able to remember the row is no reason to refuse adding it.
  }
};

// ── the store ────────────────────────────────────────────────────────

let cached: PinnedRow[] | null = null;
const listeners = new Set<() => void>();

const getSnapshot = (): PinnedRow[] => {
  if (cached === null) cached = readStored();
  return cached;
};

const getServerSnapshot = (): PinnedRow[] => EMPTY;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const commit = (rows: PinnedRow[]): void => {
  cached = rows;
  writeStored(rows);
  for (const listener of listeners) listener();
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
