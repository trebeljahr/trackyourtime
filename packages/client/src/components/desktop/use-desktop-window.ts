"use client";

import * as React from "react";
import type { DesktopWindowMode, DesktopWindowSnapshot } from "@starter/shared";
import { desktopShell } from "@/lib/desktop-shell";

export function useDesktopWindow() {
  const [snapshot, setSnapshot] = React.useState<DesktopWindowSnapshot | null>(
    null,
  );
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const controls = desktopShell()?.window;
    if (!controls) return;
    let active = true;
    let changed = false;
    const unsubscribe = controls.onChanged((next) => {
      changed = true;
      // Keep an open editor/dialog usable; its portal and focus trap live
      // outside the shell subtree that compact mode hides. Drafts stay mounted.
      if (
        next.mode === "compact" &&
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        void controls.setMode("full").catch(() => {
          if (active) setFailed(true);
        });
        return;
      }
      if (active) setSnapshot(next);
    });
    void controls
      .getState()
      .then((next) => {
        if (active && !changed) setSnapshot(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const change = React.useCallback(
    async (
      action: "mode" | "pin",
      value: DesktopWindowMode | boolean,
    ): Promise<boolean> => {
      const controls = desktopShell()?.window;
      if (!controls) return false;
      try {
        const next =
          action === "mode"
            ? await controls.setMode(value as DesktopWindowMode)
            : await controls.setAlwaysOnTop(value as boolean);
        // onChanged owns subsequent snapshots, including an editor's request to
        // remain full-size. A stale invoke result must not hide its focus trap.
        if (
          next.mode !== "compact" ||
          !document.querySelector(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          )
        )
          setSnapshot(next);
        setFailed(false);
        return true;
      } catch {
        setFailed(true);
        return false;
      }
    },
    [],
  );
  return {
    supported: snapshot !== null,
    compact: snapshot?.mode === "compact",
    alwaysOnTop: snapshot?.alwaysOnTop ?? false,
    failed,
    setMode: (mode: DesktopWindowMode) => change("mode", mode),
    setAlwaysOnTop: (enabled: boolean) => change("pin", enabled),
  };
}

export type DesktopWindowView = ReturnType<typeof useDesktopWindow>;
