"use client";

import * as React from "react";
import type { DesktopActivitySnapshot } from "@starter/shared";

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
