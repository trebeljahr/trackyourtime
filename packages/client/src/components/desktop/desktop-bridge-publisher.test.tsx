// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createTimerStore } from "@starter/core";
import type { DesktopActivitySnapshot, DesktopCommand, DesktopTimerState, RecentEntry } from "@starter/shared";

const mutations = { startQuickStart: vi.fn(), stopTimer: vi.fn() };
const push = vi.fn();
let pathname = "/app/reports";
let pending = 0;
const recentQuery = vi.fn();
const projectQuery = vi.fn();
let recentData: RecentEntry[] = [];
const { store } = vi.hoisted(() => ({ store: { current: null as ReturnType<typeof createTimerStore> | null } }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({ useEntryMutations: () => mutations }));
const idleGuard = vi.fn();
const runawayGuard = vi.fn();
vi.mock("@/components/tracker/use-idle-guard", () => ({ useIdleGuard: () => idleGuard() }));
vi.mock("@/components/tracker/use-runaway-guard", () => ({ useRunawayGuard: () => runawayGuard() }));
vi.mock("@/hooks/use-sync", async () => {
  const core = await import("@starter/core");
  store.current = core.createTimerStore();
  return { timerStore: store.current };
});
vi.mock("@/providers/offline-queue-provider", () => ({ useOfflineQueueState: () => ({ pending }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      entries: {
        recent: {
          ensureData: () => Promise.resolve(recentData),
          getData: () => recentData,
        },
      },
    }),
    settings: { get: { useQuery: () => ({ data: undefined }) } },
    projects: {
      options: {
        useQuery: (input: unknown, options: unknown) => {
          projectQuery(input, options);
          return { data: [{ id: "p1", name: "Website", color: "#ff0000" }] };
        },
      },
    },
    entries: {
      recent: {
        useQuery: (input: unknown, options: unknown) => {
          recentQuery(input, options);
          return { data: recentData };
        },
      },
    },
  },
}));

import { buildDesktopTimerState, DesktopBridgePublisher } from "./desktop-bridge-publisher";
import { translate } from "@/i18n/translate";
import { timerStore } from "@/hooks/use-sync";

const recent = (key: string, daysAgo: number, description = key): RecentEntry => ({
  key,
  description,
  projectId: null,
  taskId: null,
  billable: false,
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  projectMissing: false,
  projectArchived: false,
  taskMissing: false,
  lastStart: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  lastEntryId: `e-${key}`,
  count: 1,
});

type Bridge = {
  published: DesktopTimerState[];
  send: (command: DesktopCommand) => Promise<void>;
  showWindow: ReturnType<typeof vi.fn>;
  /** Push an activity snapshot, as main does on every change. */
  pushActivity: (snapshot: DesktopActivitySnapshot) => Promise<void>;
};

const OWNED_START = "2026-09-17T10:00:00.000Z";

const activitySnapshot = (autopilot: Partial<DesktopActivitySnapshot["autopilot"]> = {}): DesktopActivitySnapshot =>
  ({
    settings: { retentionDays: 14 },
    support: { supported: true },
    autopilot: {
      active: true,
      owned: null,
      watch: null,
      log: [],
      learnedApps: 0,
      pausedUntil: null,
      ...autopilot,
    },
  }) as DesktopActivitySnapshot;

function installBridge(initialActivity: DesktopActivitySnapshot | null = null): Bridge {
  let listener: ((command: DesktopCommand) => void) | null = null;
  let activityListener: ((snapshot: DesktopActivitySnapshot) => void) | null = null;
  const bridge: Bridge = {
    published: [],
    send: async (command) => {
      await act(async () => {
        listener?.(command);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    showWindow: vi.fn(() => Promise.resolve()),
    pushActivity: async (snapshot) => {
      await act(async () => {
        activityListener?.(snapshot);
        await Promise.resolve();
      });
    },
  };
  (window as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    platform: "darwin",
    ...(initialActivity === null
      ? {}
      : {
          activity: {
            snapshot: () => Promise.resolve(initialActivity),
            onChanged: (next: (snapshot: DesktopActivitySnapshot) => void) => {
              activityListener = next;
              return () => {
                activityListener = null;
              };
            },
          },
        }),
    desktop: {
      publishTimerState: (state: DesktopTimerState) => {
        bridge.published.push(state);
        return Promise.resolve();
      },
      onCommand: (next: (command: DesktopCommand) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      showWindow: bridge.showWindow,
    },
  };
  return bridge;
}

beforeEach(() => {
  pathname = "/app/reports";
  pending = 0;
  recentData = [];
  timerStore.getState().clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("buildDesktopTimerState", () => {
  it("labels, recents and the unsent count come from the renderer", () => {
    const state = buildDesktopTimerState({
      running: null,
      projects: [],
      recents: Array.from({ length: 8 }, (_, i) => recent(`k${i}`, 1)),
      unsent: 2,
      t: translate("shell"),
    });
    expect(state.recents).toHaveLength(5);
    expect(state.labels.unsent).toBe("2 changes not sent yet");
    expect(state.labels.quitUnsentTitle).toBe("2 changes are not sent yet");
    expect(state.running).toBeNull();
    expect(state.autopilot).toBeNull();
    expect(state.labels.autopilotPaused).toBe("");
  });

  const owned = { start: Date.parse(OWNED_START), filingKey: "k", app: null, via: "rule" as const, logId: "l1" };
  const runningEntry = { id: "e1", description: "Write", start: OWNED_START, end: null, projectId: null } as never;

  it("marks the timer Autopilot opened, and only that one", () => {
    const build = (autopilot: Parameters<typeof buildDesktopTimerState>[0]["autopilot"], running = runningEntry) =>
      buildDesktopTimerState({ running, projects: [], recents: [], unsent: 0, t: translate("shell"), autopilot });
    expect(build({ active: true, owned, pausedUntil: null }).running?.autopilot).toBe(true);
    expect(build({ active: true, owned, pausedUntil: null }).autopilot).toEqual({ pausedUntil: null });
    const other = { ...(runningEntry as object), start: "2026-09-17T11:00:00.000Z" } as never;
    expect(build({ active: true, owned, pausedUntil: null }, other).running).not.toHaveProperty("autopilot");
    // Off: no mark and no tray item, whatever main last said it owned.
    const off = build({ active: false, owned, pausedUntil: null });
    expect(off.running).not.toHaveProperty("autopilot");
    expect(off.autopilot).toBeNull();
    expect(build(null).autopilot).toBeNull();
  });

  it("hands over the pause with its translated labels", () => {
    const until = Date.parse("2026-09-17T11:30:00.000Z");
    const state = buildDesktopTimerState({
      running: null,
      projects: [],
      recents: [],
      unsent: 0,
      t: translate("shell"),
      autopilot: { active: true, owned: null, pausedUntil: until },
      clock: (iso) => `<${iso}>`,
    });
    expect(state.autopilot).toEqual({ pausedUntil: until });
    expect(state.labels.autopilotPause).toBe("Pause Autopilot for an hour");
    expect(state.labels.autopilotResume).toBe("Resume Autopilot");
    expect(state.labels.autopilotPaused).toBe("Autopilot paused until <2026-09-17T11:30:00.000Z>");
  });
});

describe("DesktopBridgePublisher", () => {
  it("on the web it queries nothing and publishes nothing", () => {
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    expect(recentQuery.mock.calls.every(([, options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
    expect(projectQuery.mock.calls.every(([, options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
  });

  it("keeps the idle and runaway guards running off the tracker, in the desktop app only", async () => {
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    expect(idleGuard).not.toHaveBeenCalled();
    cleanup();

    installBridge();
    const view = render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await act(async () => undefined);
    expect(idleGuard).toHaveBeenCalled();
    expect(runawayGuard).toHaveBeenCalled();
    view.unmount();

    // The tracker bar mounts its own copies there; two would double every prompt.
    vi.clearAllMocks();
    pathname = "/app/track/";
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await act(async () => undefined);
    expect(idleGuard).not.toHaveBeenCalled();
    expect(runawayGuard).not.toHaveBeenCalled();
  });

  it("publishes the running entry with its project, and signs out on unmount", async () => {
    const bridge = installBridge();
    act(() => {
      timerStore.getState().setRunning({
        id: "e1",
        description: "Write",
        start: "2026-09-17T10:00:00.000Z",
        end: null,
        projectId: "p1",
      } as never);
    });
    const view = render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await act(async () => undefined);
    const last = bridge.published.at(-1);
    expect(last?.running).toEqual({
      description: "Write",
      startedAt: "2026-09-17T10:00:00.000Z",
      projectName: "Website",
      projectColor: "#ff0000",
    });
    view.unmount();
    expect(bridge.published.at(-1)?.signedIn).toBe(false);
  });

  it("publishes what main says about Autopilot, and again when its pause changes", async () => {
    const owned = { start: Date.parse(OWNED_START), filingKey: "k", app: null, via: "rule" as const, logId: "l1" };
    const bridge = installBridge(activitySnapshot({ owned }));
    act(() => {
      timerStore.getState().setRunning({ id: "e1", description: "Write", start: OWNED_START, end: null } as never);
    });
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await act(async () => undefined);
    expect(bridge.published.at(-1)?.running?.autopilot).toBe(true);
    expect(bridge.published.at(-1)?.autopilot).toEqual({ pausedUntil: null });

    // A push that changes nothing the tray draws publishes nothing.
    const count = bridge.published.length;
    await bridge.pushActivity(activitySnapshot({ owned, learnedApps: 3 }));
    expect(bridge.published.length).toBe(count);

    const until = Date.now() + 60 * 60_000;
    await bridge.pushActivity(activitySnapshot({ owned, pausedUntil: until }));
    expect(bridge.published.at(-1)?.autopilot).toEqual({ pausedUntil: until });
    expect(bridge.published.at(-1)?.labels.autopilotPaused).toMatch(/^Autopilot paused until /);

    await bridge.pushActivity(activitySnapshot({ active: false, owned: null }));
    expect(bridge.published.at(-1)?.autopilot).toBeNull();
    expect(bridge.published.at(-1)?.running).not.toHaveProperty("autopilot");
  });

  it("toggle stops a running timer", async () => {
    const bridge = installBridge();
    act(() => {
      timerStore.getState().setRunning({ id: "e1", description: "", start: new Date().toISOString(), end: null } as never);
    });
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await bridge.send({ kind: "toggle" });
    expect(mutations.stopTimer).toHaveBeenCalledOnce();
    expect(mutations.startQuickStart).not.toHaveBeenCalled();
  });

  it("toggle continues the newest recent inside seven days", async () => {
    const bridge = installBridge();
    recentData = [recent("old", 3), recent("new", 1), recent("stale", 12)];
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await bridge.send({ kind: "toggle" });
    expect(mutations.startQuickStart).toHaveBeenCalledWith({
      description: "new",
      projectId: null,
      taskId: null,
      billable: false,
    });
    expect(bridge.showWindow).not.toHaveBeenCalled();
  });

  it("toggle with nothing to resume shows the window on the composer", async () => {
    const bridge = installBridge();
    recentData = [recent("stale", 12)];
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    await bridge.send({ kind: "toggle" });
    expect(mutations.startQuickStart).not.toHaveBeenCalled();
    expect(bridge.showWindow).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/app/track");
  });

  it("routes the other commands", async () => {
    const bridge = installBridge();
    recentData = [recent("k1", 1, "Review")];
    const openPalette = vi.fn();
    render(<DesktopBridgePublisher onOpenPalette={openPalette} />);
    await bridge.send({ kind: "continue", key: "k1" });
    expect(mutations.startQuickStart).toHaveBeenCalledWith(expect.objectContaining({ description: "Review" }));
    await bridge.send({ kind: "open-palette" });
    expect(openPalette).toHaveBeenCalledOnce();
    await bridge.send({ kind: "open-settings" });
    expect(push).toHaveBeenCalledWith("/app/settings?tab=desktop");
    await bridge.send({ kind: "stop" });
    expect(mutations.stopTimer).not.toHaveBeenCalled();
  });
});
