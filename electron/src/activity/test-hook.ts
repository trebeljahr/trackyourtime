/*
 * `globalThis.__trackYourTimeDesktop.activity`, headless runs only.
 *
 * Playwright drives capture through this: what is in front (the fake
 * source), what time it is, when a detection or a heartbeat happens, and
 * whether the person is idle — so a spec is deterministic and nothing about
 * the machine it runs on (its frontmost app, its owner's typing) can reach it.
 */

import type { DesktopActivitySupport } from "../../../packages/shared/src/desktop-bridge.ts";
import type { FrontmostTarget } from "./keys.ts";
import type { PresenceState } from "./model.ts";
import type { ActivityService } from "./service.ts";
import type { FakeFrontmostSource } from "./source-fake.ts";
import type { SourceKind } from "./source.ts";

export interface ActivityTestHook {
  setFrontmost: (target: { key: string; name: string; title?: string } | null) => void;
  /** Pin the clock capture reads; null goes back to the real one. */
  setNow: (epochMs: number | null) => void;
  /** One detection at the current (fake) time, settled. */
  tick: () => Promise<void>;
  heartbeat: () => Promise<void>;
  idle: (state: PresenceState, idleSeconds?: number) => Promise<void>;
  /** Simulate a channel or session without capture (store, Wayland…); null restores it. */
  setSupport: (support: DesktopActivitySupport | null) => Promise<void>;
  setTitlesAvailable: (on: boolean) => Promise<void>;
  sourceKind: () => SourceKind | null;
  /** Whether the fake source is running, i.e. capture is actually on. */
  capturing: () => boolean;
  /** Every child process capture attempted. Headless, this stays empty. */
  spawns: () => string[];
  files: () => { state: unknown; open: unknown; segments: unknown[] };
}

export function createActivityTestHook(options: {
  service: ActivityService;
  fake: FakeFrontmostSource;
  spawns: readonly string[];
  setNow: (epochMs: number | null) => void;
}): ActivityTestHook {
  const { service, fake } = options;
  return {
    setFrontmost: (target) => {
      const next: FrontmostTarget | null =
        target === null
          ? null
          : { key: target.key, name: target.name, ...(target.title !== undefined ? { title: target.title } : {}) };
      fake.setFrontmost(next);
    },
    setNow: options.setNow,
    tick: async () => {
      await service.settled();
      fake.emit();
      await service.settled();
    },
    heartbeat: () => service.heartbeat(),
    idle: (state, idleSeconds) => service.presence(state, idleSeconds ?? (state === "idle" ? 120 : 0)),
    setSupport: (support) => service.setSupportOverride(support),
    setTitlesAvailable: (on) => service.setTitlesAvailable(on),
    sourceKind: () => service.sourceKind(),
    capturing: () => fake.running(),
    spawns: () => [...options.spawns],
    files: () => service.files(),
  };
}
