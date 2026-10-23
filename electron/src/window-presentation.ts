import type {
  DesktopWindowMode,
  DesktopWindowSnapshot,
} from "../../packages/shared/src/desktop-bridge.ts";
import {
  COMPACT_MIN_SIZE,
  MIN_SIZE,
  initialBounds,
  type Rect,
  type WindowState,
} from "./window-state.ts";

export interface PresentationWindow {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMaximized: () => boolean;
  isFullScreen: () => boolean;
  getNormalBounds: () => Rect;
  setMinimumSize: (width: number, height: number) => void;
  setBounds: (
    bounds: Partial<Rect> & { width: number; height: number },
  ) => void;
  setAlwaysOnTop: (enabled: boolean) => void;
  unmaximize: () => void;
  maximize: () => void;
}

/** One renderer, two remembered sizes. Auth screens always get the full app. */
export function createWindowPresentation(options: {
  window: PresentationWindow;
  saved: WindowState;
  headless: boolean;
  workAreas: () => Rect[];
  leaveFullscreen: () => Promise<void>;
  save: (patch: WindowState) => void;
  changed: (snapshot: DesktopWindowSnapshot) => void;
}) {
  const win = options.window;
  let saved = { ...options.saved };
  let mode: DesktopWindowMode = "full";
  let preferred = saved.mode ?? "full";
  let pinned = saved.alwaysOnTop ?? false;
  let signedIn = false;
  let transition: Promise<void> = Promise.resolve();
  let switching = false;
  const snapshot = (): DesktopWindowSnapshot => ({ mode, alwaysOnTop: pinned });
  const persist = (patch: WindowState): void => {
    saved = { ...saved, ...patch, mode: preferred, alwaysOnTop: pinned };
    options.save(saved);
  };
  const remember = (): void => {
    if (win.isDestroyed() || switching) return;
    persist(
      mode === "compact"
        ? { compactBounds: win.getNormalBounds() }
        : {
            bounds: win.getNormalBounds(),
            maximized: win.isMaximized(),
            fullscreen: win.isFullScreen(),
          },
    );
  };
  const apply = async (): Promise<void> => {
    if (win.isDestroyed()) return;
    const target = signedIn ? preferred : "full";
    if (mode !== target) {
      remember();
      switching = true;
      try {
        await options.leaveFullscreen();
        if (win.isDestroyed()) return;
        // Authentication may have changed while the OS left fullscreen.
        const next = signedIn ? preferred : "full";
        if (next !== mode) {
          if (win.isMaximized()) win.unmaximize();
          const minimum = next === "compact" ? COMPACT_MIN_SIZE : MIN_SIZE;
          // Shrink the minimum before shrinking the window, and restore bounds
          // before raising it again. Each mode keeps its own normal rectangle.
          win.setMinimumSize(1, 1);
          win.setBounds(
            initialBounds(
              next === "compact" ? saved.compactBounds : saved.bounds,
              options.workAreas(),
              next,
            ),
          );
          win.setMinimumSize(minimum.width, minimum.height);
          mode = next;
          if (
            next === "full" &&
            saved.maximized &&
            !options.headless &&
            win.isVisible()
          )
            win.maximize();
        }
      } finally {
        switching = false;
      }
    }
    // No pinning or activation of any real window during agent/test runs.
    if (!options.headless)
      win.setAlwaysOnTop(signedIn && mode === "compact" && pinned);
    persist({});
    options.changed(snapshot());
  };
  const enqueue = (): Promise<DesktopWindowSnapshot> => {
    transition = transition.catch(() => undefined).then(apply);
    return transition.then(snapshot);
  };
  return {
    snapshot,
    remember,
    setMode: (next: DesktopWindowMode) => {
      preferred = next;
      return enqueue();
    },
    setAlwaysOnTop: (enabled: boolean) => {
      pinned = enabled;
      return enqueue();
    },
    setSignedIn: (enabled: boolean) => {
      if (signedIn === enabled) return transition.then(snapshot);
      signedIn = enabled;
      return enqueue();
    },
  };
}

export type WindowPresentation = ReturnType<typeof createWindowPresentation>;
