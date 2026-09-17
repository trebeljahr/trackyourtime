/*
 * Global shortcuts: register the bindings from Settings → Desktop, report
 * what did not register, and step aside while Settings records a new key.
 *
 * `createShortcutManager` takes the registrar as an argument, so every rule is
 * unit-tested without Electron: the real one is `globalShortcut`, headless
 * runs pass an in-memory one (nothing is registered with the OS while tests
 * run on somebody's machine) whose "taken" chords a spec can set.
 *
 * `globalShortcut.register` returns false when another application or the OS
 * already holds the chord, and throws on an accelerator it cannot parse. Both
 * end up in the status list Settings shows; neither is swallowed.
 */

import type { DesktopShortcutStatus } from "../../packages/shared/src/desktop-bridge.ts";
import {
  DESKTOP_SHORTCUT_ACTIONS,
  type DesktopShortcutAction,
  type DesktopShortcutBindings,
} from "../../packages/shared/src/desktop-shortcuts.ts";

export interface ShortcutRegistrar {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
}

export interface ShortcutManager {
  /** Replace every registration with `bindings`; returns the new statuses. */
  apply: (bindings: DesktopShortcutBindings) => DesktopShortcutStatus[];
  /** Unregister everything until `resume`, keeping the bindings. */
  suspend: () => void;
  resume: () => DesktopShortcutStatus[];
  isSuspended: () => boolean;
  statuses: () => DesktopShortcutStatus[];
  /** Unregister everything (quit). */
  dispose: () => void;
}

export function createShortcutManager(
  registrar: ShortcutRegistrar,
  onTrigger: (action: DesktopShortcutAction) => void,
): ShortcutManager {
  let bindings: DesktopShortcutBindings | null = null;
  let suspended = false;
  /** Accelerators this manager registered, so it never unregisters somebody else's. */
  const held = new Set<string>();
  let current: DesktopShortcutStatus[] = [];

  const release = (): void => {
    for (const accelerator of held) {
      try {
        registrar.unregister(accelerator);
      } catch {
        /* already gone */
      }
    }
    held.clear();
  };

  const registerAll = (): DesktopShortcutStatus[] => {
    release();
    if (bindings === null) return [];
    const statuses: DesktopShortcutStatus[] = [];
    for (const action of DESKTOP_SHORTCUT_ACTIONS) {
      const accelerator = bindings[action];
      if (accelerator === null) {
        statuses.push({ action, accelerator: null, registered: false, problem: null });
        continue;
      }
      if (suspended) {
        statuses.push({ action, accelerator, registered: false, problem: null });
        continue;
      }
      let registered = false;
      let problem: DesktopShortcutStatus["problem"] = null;
      try {
        registered = registrar.register(accelerator, () => onTrigger(action));
        if (!registered) problem = "taken";
      } catch {
        problem = "invalid";
      }
      if (registered) held.add(accelerator);
      statuses.push({ action, accelerator, registered, problem });
    }
    return statuses;
  };

  return {
    apply: (next) => {
      bindings = { ...next };
      current = registerAll();
      return current;
    },
    suspend: () => {
      suspended = true;
      current = registerAll();
    },
    resume: () => {
      suspended = false;
      current = registerAll();
      return current;
    },
    isSuspended: () => suspended,
    statuses: () => current,
    dispose: () => {
      release();
      bindings = null;
      current = [];
    },
  };
}

/**
 * The registrar headless runs use: nothing reaches the OS. `taken` stands in
 * for chords another application holds, so a spec can see a failure surface.
 */
export function createMemoryRegistrar(): ShortcutRegistrar & {
  taken: Set<string>;
  registered: Map<string, () => void>;
} {
  const taken = new Set<string>();
  const registered = new Map<string, () => void>();
  return {
    taken,
    registered,
    register: (accelerator, callback) => {
      if (taken.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      registered.delete(accelerator);
    },
  };
}
