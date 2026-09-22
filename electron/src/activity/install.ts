/*
 * Desktop activity capture (docs/desktop-app-plan.md, Stage 8), wired into
 * Electron: the IPC channels, the idle monitor, the one-minute heartbeat, the
 * daily prune and the change push.
 *
 * **Headless** (tests, agents) builds the fake source and nothing else: no
 * platform source, no `child_process`, no heartbeat or prune timer, and idle
 * comes from the test hook rather than `powerMonitor`, so neither the real
 * frontmost app nor the machine owner's typing can reach a spec. The
 * `createPlatformSource(` call below sits in the non-headless branch only, and
 * `headless.test.ts` greps for exactly that.
 *
 * Capture is off until the person turns it on in Settings, and nothing here
 * turns it on.
 */

import { BrowserWindow } from "electron";

import {
  DESKTOP_IPC,
  type DesktopActivityAcceptCheck,
  type DesktopActivityRule,
  type DesktopActivitySnapshot,
} from "../../../packages/shared/src/desktop-bridge.ts";
import { activityCaptureSupport, type DistributionChannel } from "../distribution.ts";
import type { IdleSample } from "../idle.ts";
import { handle } from "../ipc.ts";
import {
  parseCheckAcceptInput,
  parseInterval,
  parseRuleId,
  parseRuleInput,
  parseScope,
  parseSettingsPatch,
  parseSuggestionsInput,
} from "./ipc-parse.ts";
import { HEARTBEAT_MS } from "./model.ts";
import { createPlatformSource } from "./platform-source.ts";
import { createActivityService, type ActivityService } from "./service.ts";
import { createFakeFrontmostSource } from "./source-fake.ts";
import type { FrontmostSource } from "./source.ts";
import { createActivityTestHook, type ActivityTestHook } from "./test-hook.ts";

/** At most one `activity:changed` push per this long. */
export const CHANGED_THROTTLE_MS = 2_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

export interface ActivityController {
  /** Headless only. */
  testHook: ActivityTestHook | null;
  /** On quit: persist the open segment, stop the source and the timers. */
  dispose: () => void;
}

export function installActivity(options: {
  headless: boolean;
  platform: NodeJS.Platform;
  channel: DistributionChannel;
  env: Record<string, string | undefined>;
  userData: string;
  /** The idle monitor (idle.ts). Not subscribed headless. */
  subscribeIdle: (listener: (sample: IdleSample) => void) => () => void;
}): ActivityController {
  const { headless, platform, env } = options;
  const support = activityCaptureSupport(options.channel, platform, env);
  const spawns: string[] = [];
  let fakeNow: number | null = null;
  const now = (): number => fakeNow ?? Date.now();

  const fake = headless ? createFakeFrontmostSource() : null;
  let source: FrontmostSource | null = fake;
  if (!headless && support.kind === "supported") {
    source = createPlatformSource(support.mechanism, { env, parentPid: process.pid, spawns });
  }

  // ── change push, throttled ──────────────────────────────────────────
  let service: ActivityService | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const push = (): void => {
    void service?.snapshot().then((snapshot: DesktopActivitySnapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(DESKTOP_IPC.activityChanged, snapshot);
      }
    });
  };
  const changed = (): void => {
    if (pushTimer !== null) {
      dirty = true;
      return;
    }
    push();
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (dirty) {
        dirty = false;
        changed();
      }
    }, CHANGED_THROTTLE_MS);
  };

  const activity = createActivityService({
    userData: options.userData,
    support,
    // Window titles need Screen Recording on macOS, which Stage 8 never asks for.
    titlesAvailable: platform !== "darwin",
    source,
    selfPid: process.pid,
    now,
    onChanged: changed,
  });
  service = activity;

  // ── IPC ─────────────────────────────────────────────────────────────
  const currentRules = async (): Promise<DesktopActivityRule[]> => (await activity.snapshot()).rules;

  handle(DESKTOP_IPC.activitySnapshot, () => activity.snapshot());
  handle(DESKTOP_IPC.activitySettings, (_event, patch: unknown) => {
    const parsed = parseSettingsPatch(patch);
    return parsed === null ? activity.snapshot() : activity.updateSettings(parsed);
  });
  handle(DESKTOP_IPC.activityScope, async (_event, scope: unknown) => {
    const parsed = parseScope(scope);
    if (parsed !== null) await activity.setScope(parsed);
  });
  handle(DESKTOP_IPC.activityForget, () => activity.forget());
  handle(DESKTOP_IPC.activityWipe, () => activity.wipe());
  handle(DESKTOP_IPC.activitySuggestions, (_event, input: unknown) => {
    const parsed = parseSuggestionsInput(input);
    return parsed === null ? null : activity.suggestions(parsed);
  });
  handle(DESKTOP_IPC.activityCheckAccept, (_event, input: unknown) => {
    const parsed = parseCheckAcceptInput(input);
    const refused: DesktopActivityAcceptCheck = { ok: false, reason: "bad-range" };
    return parsed === null ? refused : activity.checkAccept(parsed);
  });
  handle(DESKTOP_IPC.activityAccepted, async (_event, span: unknown) => {
    const parsed = parseInterval(span);
    if (parsed !== null) await activity.markAccepted(parsed);
  });
  handle(DESKTOP_IPC.activityDismiss, (_event, span: unknown) => {
    const parsed = parseInterval(span);
    return parsed === null ? false : activity.dismiss(parsed);
  });
  handle(DESKTOP_IPC.activityRuleAdd, (_event, rule: unknown) => {
    const parsed = parseRuleInput(rule);
    return parsed === null ? currentRules() : activity.addRule(parsed);
  });
  handle(DESKTOP_IPC.activityRuleRemove, (_event, id: unknown) => {
    const parsed = parseRuleId(id);
    return parsed === null ? currentRules() : activity.removeRule(parsed);
  });

  // ── timers and idle (never headless) ────────────────────────────────
  const timers: ReturnType<typeof setInterval>[] = [];
  let unsubscribeIdle: (() => void) | null = null;
  if (!headless) {
    timers.push(setInterval(() => void activity.heartbeat(), HEARTBEAT_MS));
    timers.push(setInterval(() => void activity.prune(), PRUNE_EVERY_MS));
    unsubscribeIdle = options.subscribeIdle((sample) => void activity.presence(sample.state, sample.idleSeconds));
  }

  const testHook =
    headless && fake !== null
      ? createActivityTestHook({
          service: activity,
          fake,
          spawns,
          setNow: (epochMs) => {
            fakeNow = epochMs;
          },
        })
      : null;

  return {
    testHook,
    dispose: () => {
      for (const timer of timers) clearInterval(timer);
      if (pushTimer !== null) clearTimeout(pushTimer);
      unsubscribeIdle?.();
      activity.dispose();
    },
  };
}
