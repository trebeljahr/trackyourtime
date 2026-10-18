"use client";

import * as React from "react";
import type { DesktopActivitySnapshot, DesktopAutopilotState } from "@starter/shared";

import { useIsElectron } from "@/hooks/use-shell";
import { desktopActivity } from "@/lib/desktop-activity";

/**
 * The desktop app's activity state, or null: on the web, in a desktop build
 * whose preload has no activity bridge, and until main has answered.
 *
 * Read after mount only (`useIsElectron` hydrates as the web), so the
 * prerendered tree and hydration always agree. Main pushes a fresh snapshot
 * on every change (`onChanged`, throttled there), so nothing here polls.
 */
export const useDesktopActivitySnapshot = (): DesktopActivitySnapshot | null => {
  const electron = useIsElectron();
  const [snapshot, setSnapshot] = React.useState<DesktopActivitySnapshot | null>(null);

  React.useEffect(() => {
    if (!electron) return;
    const activity = desktopActivity();
    if (activity === null) return;
    let live = true;
    const unsubscribe = activity.onChanged((next) => {
      if (live) setSnapshot(next);
    });
    activity.snapshot().then(
      (next) => {
        if (live) setSnapshot(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [electron]);

  return electron ? snapshot : null;
};

/**
 * The desktop app, with activity capture possible on this OS and channel.
 *
 * Kept as a boolean in state rather than derived from the snapshot: the nav
 * (in `AppShell`) reads this, and main pushes a new snapshot every couple of
 * seconds while it records. A snapshot in state would re-render the whole
 * shell on each push; an unchanged boolean lets React bail out.
 */
export const useDesktopActivityAvailable = (): boolean => {
  const electron = useIsElectron();
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    if (!electron) return;
    const activity = desktopActivity();
    if (activity === null) return;
    let live = true;
    const take = (next: DesktopActivitySnapshot): void => {
      if (live) setAvailable(next.support.supported);
    };
    const unsubscribe = activity.onChanged(take);
    activity.snapshot().then(take, () => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [electron]);

  return electron && available;
};

/** What the tray needs of Autopilot: whether it is on, the timer it opened, and its pause. */
export type DesktopAutopilotBrief = Pick<DesktopAutopilotState, "active" | "owned" | "pausedUntil">;

const sameBrief = (a: DesktopAutopilotBrief | null, b: DesktopAutopilotBrief | null): boolean => {
  if (a === null || b === null) return a === b;
  return (
    a.active === b.active &&
    a.pausedUntil === b.pausedUntil &&
    a.owned?.start === b.owned?.start &&
    a.owned?.filingKey === b.owned?.filingKey &&
    a.owned?.logId === b.owned?.logId
  );
};

/**
 * {@link DesktopAutopilotBrief}, or null on the web and before main answers.
 * A new object only when one of its fields changed: the tray publisher reads
 * this, and main pushes a snapshot every couple of seconds while it records.
 */
export const useDesktopAutopilotBrief = (): DesktopAutopilotBrief | null => {
  const electron = useIsElectron();
  const [brief, setBrief] = React.useState<DesktopAutopilotBrief | null>(null);

  React.useEffect(() => {
    if (!electron) return;
    const activity = desktopActivity();
    if (activity === null) return;
    let live = true;
    const take = (next: DesktopActivitySnapshot): void => {
      if (!live) return;
      const state = next.autopilot;
      const value: DesktopAutopilotBrief | null =
        state === undefined ? null : { active: state.active, owned: state.owned, pausedUntil: state.pausedUntil };
      setBrief((previous) => (sameBrief(previous, value) ? previous : value));
    };
    const unsubscribe = activity.onChanged(take);
    activity.snapshot().then(take, () => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [electron]);

  return electron ? brief : null;
};

/** `setTimeout` takes a signed 32-bit delay; anything longer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * When an Autopilot pause ends, or null when there is none or it has run out.
 * Main pushes nothing when a pause simply expires, so this re-renders at that
 * moment by itself.
 */
export const useActivePause = (pausedUntil: number | null | undefined): number | null => {
  const until = pausedUntil ?? null;
  // Bumped when the pause runs out, so the render below reads the clock again.
  const [, setExpired] = React.useState(0);

  React.useEffect(() => {
    if (until === null) return;
    const left = until - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setExpired((count) => count + 1), Math.min(left + 50, MAX_TIMEOUT_MS));
    return () => window.clearTimeout(timer);
  }, [until]);

  // Reads the clock during render on purpose: a pause that ran out while
  // nothing was pushed is no pause, and the timeout above re-renders then.
  // eslint-disable-next-line react-hooks/purity
  return until !== null && until > Date.now() ? until : null;
};
