"use client";

/**
 * The running timer, written somewhere it survives the app being killed.
 *
 * Without this, a cold launch with no network shows no timer at all — not a
 * stale one, not a spinner: `trpc.entries.current` has no persisted React
 * Query cache, so it never answers, and the store stays at its `null` initial
 * state. The user force-quits a running timer on the train, opens the app
 * again, and the app they are using to track time says nothing is running.
 *
 * So every server answer about the running entry is mirrored into Capacitor
 * Preferences, and the store is seeded from that mirror at boot, before the
 * query fires. `packages/core/src/timer-store.ts` derives elapsed seconds from
 * `entry.start` against the wall clock — it never accumulates — so a seeded
 * entry ticks correctly straight away no matter how long the app was dead.
 *
 * Two rules:
 *
 *  - **Native only.** On web a reload is online by definition and the query
 *    answers in milliseconds; seeding there would mean every reload flashes
 *    the previous timer before the server has a say.
 *  - **The seed is provisional.** It is what the server said last time, not
 *    what the server says now. `useRunningEntry` replaces it the moment the
 *    query actually succeeds — including with `null`, which is how a timer
 *    stopped from another device disappears — and only a real success is
 *    allowed to overwrite it.
 */

import {
  decodeVersioned,
  encodeVersioned,
  memoryStorage,
  readRunningEntryLeniently,
  webStorage,
  type KeyValueStorage,
  type TimerStore,
  type VersionedSpec,
} from "@starter/core";
import type { TimeEntry } from "@starter/shared";

import { isCapacitor, isTokenShell } from "@/lib/shell";
import { preferencesStorage } from "@/mobile/preferences-storage";

const MIRROR_KEY = "trackyourtime.running-entry";

let storage: KeyValueStorage | null = null;

/*
 * Capacitor Preferences on the phones, where WKWebView evicts `localStorage`;
 * `localStorage` in the Electron shell, where nothing evicts it and there is
 * no Preferences plugin.
 */
const resolveStorage = (): KeyValueStorage => {
  if (isCapacitor()) return preferencesStorage();
  try {
    return webStorage(window.localStorage);
  } catch {
    return memoryStorage();
  }
};

const store = (): KeyValueStorage => {
  storage ??= resolveStorage();
  return storage;
};

/**
 * Whether the entry in the timer store came from the mirror rather than from
 * the server this launch. Nothing may treat a provisional entry as
 * authoritative — in particular the seed itself, which must never overwrite a
 * fresher answer.
 */
let provisional = false;

export const isRunningProvisional = (): boolean => provisional;

/**
 * A mirrored entry has to look like a running entry to be worth restoring.
 * Anything else — a finished entry left behind by an older build, a truncated
 * write, a version a newer build wrote — is treated as "nothing was running",
 * which is the safe reading.
 *
 * Lenient past that on purpose: this may be the only copy of the running timer
 * on a cold offline launch, so a field an older build never wrote, or one a
 * newer build added, must not throw the timer away. Version 1 is the entry
 * itself inside the envelope; builds before it wrote the bare entry.
 */
const MIRROR_SPEC: VersionedSpec<TimeEntry> = {
  version: 1,
  decode: readRunningEntryLeniently,
  legacy: readRunningEntryLeniently,
};

const parseMirrored = (raw: string | null): TimeEntry | null =>
  decodeVersioned(raw, MIRROR_SPEC);

/** Record what the server last said is running. `null` clears the mirror. */
export const writeRunningMirror = async (
  entry: TimeEntry | null,
): Promise<void> => {
  if (!isTokenShell()) return;
  provisional = false;
  if (entry === null || entry.end !== null) {
    await store().removeItem(MIRROR_KEY);
    return;
  }
  await store().setItem(MIRROR_KEY, encodeVersioned(MIRROR_SPEC.version, entry));
};

/** Read the mirror back. Null on web, and whenever it holds nothing usable. */
export const readRunningMirror = async (): Promise<TimeEntry | null> => {
  if (!isTokenShell()) return null;
  return parseMirrored(await store().getItem(MIRROR_KEY));
};

/**
 * Put the mirrored entry into the timer store, if the store is still empty.
 *
 * The emptiness check is the whole safety argument: this read is asynchronous,
 * so by the time it lands the query may already have answered — with a
 * different entry, or with `null` because the timer was stopped elsewhere.
 * Seeding over that would resurrect a stopped timer, which is worse than the
 * blank screen this exists to fix.
 */
export const seedRunningFromMirror = async (
  timerStore: TimerStore,
): Promise<TimeEntry | null> => {
  if (!isTokenShell()) return null;

  const entry = await readRunningMirror();
  if (entry === null) return null;
  if (timerStore.getState().running !== null) return null;

  provisional = true;
  timerStore.getState().setRunning(entry);
  return entry;
};

/**
 * Test seam. Passing a storage also pins the backing store, so a spec can put
 * a malformed value in front of the parser without knowing how Capacitor's own
 * web fallback names its keys.
 */
export const __resetRunningMirrorForTests = (
  next: KeyValueStorage | null = null,
): void => {
  storage = next;
  provisional = false;
};
