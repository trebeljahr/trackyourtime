/*
 * What is in front of the person, per OS, behind one interface.
 *
 * A source reports the frontmost application (`FrontmostTarget`) or `null`
 * when nothing recordable is in front, and a failure when it cannot answer at
 * all. It never decides anything: exclusion, titles, idleness and the segment
 * lifecycle are `model.ts`.
 *
 * No native module on any OS (docs/desktop-app-plan.md, Stage 8):
 *
 * - macOS: `/usr/bin/lsappinfo`, polled (`source-macos.ts`). No Screen
 *   Recording, Accessibility or Automation permission, so no prompt.
 * - Windows: one long-lived `powershell.exe` with an embedded script
 *   (`source-windows.ts`).
 * - Linux X11: `xprop -spy` (`source-linux.ts`).
 *
 * Headless runs (tests, agents) use `source-fake.ts` and nothing else: no
 * child process, no timer, and the machine owner's real frontmost app is
 * never read. Spawning goes through a `ProcessRunner`, so the platform
 * sources are unit-tested with a fake one.
 */

import type { ActivityCaptureMechanism } from "../distribution.ts";
import type { FrontmostTarget } from "./keys.ts";

export type SourceKind = "fake" | ActivityCaptureMechanism;

export type SourceFailureReason = "tool-missing" | "blocked-by-policy" | "source-failed";

export interface SourceFailure {
  reason: SourceFailureReason;
  /** A package or tool name for `tool-missing`; never prose. */
  hint: string | null;
}

export interface SourceListener {
  /** What is in front now. Sources may repeat the same answer; that keeps a segment alive. */
  target: (target: FrontmostTarget | null) => void;
  /** A failure, or null once the source answers again. */
  failure: (failure: SourceFailure | null) => void;
}

export interface FrontmostSource {
  readonly kind: SourceKind;
  start: (listener: SourceListener) => void;
  /** Stops polling and kills any child process. Idempotent. */
  stop: () => void;
  /** Titles on or off. Where a helper bakes it in, it is restarted. */
  setTitles: (on: boolean) => void;
}

// ── processes ─────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  stdout: string;
}

export interface ChildHandle {
  onLine: (listener: (line: string) => void) => void;
  onExit: (listener: (code: number | null) => void) => void;
  kill: () => void;
}

/**
 * Every child process a source starts. Absolute paths, fixed argv, never a
 * shell: `install.ts` builds the real one from `process-runner.ts` in the
 * non-headless branch only.
 */
export interface ProcessRunner {
  run: (file: string, args: readonly string[], options?: { env?: Record<string, string> }) => Promise<RunResult>;
  spawn: (file: string, args: readonly string[], options?: { env?: Record<string, string> }) => ChildHandle;
}

// ── timers ────────────────────────────────────────────────────────────

export interface Timers {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ── restart policy ────────────────────────────────────────────────────

/** Three failures inside this window and the source gives up for a while. */
export const FAILURE_WINDOW_MS = 10 * 60_000;
export const MAX_FAILURES = 3;
/** How long a source that gave up waits before trying again. */
export const RETRY_AFTER_MS = 5 * 60_000;

export interface RestartPolicy {
  /** Record a failure; answers whether to retry at once or give up for {@link RETRY_AFTER_MS}. */
  fail: () => "restart" | "give-up";
  /** A good answer arrived. */
  succeed: () => void;
}

export function createRestartPolicy(now: () => number): RestartPolicy {
  let failures: number[] = [];
  return {
    fail: () => {
      const at = now();
      failures = [...failures.filter((t) => at - t < FAILURE_WINDOW_MS), at];
      if (failures.length >= MAX_FAILURES) {
        failures = [];
        return "give-up";
      }
      return "restart";
    },
    succeed: () => {
      failures = [];
    },
  };
}

/** The longest stdout line a source accepts; anything longer is not the tool talking. */
export const MAX_LINE_BYTES = 64 * 1024;

/** Splits a byte stream into lines, dropping over-long ones. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  let discarding = false;
  return (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!discarding) onLine(line);
      discarding = false;
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = "";
      discarding = true;
    }
  };
}
