// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createTimerStore } from "@starter/core";
import type { DesktopCommand, DesktopTimerState, RecentEntry } from "@starter/shared";

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
    projects: {
      list: {
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
};

function installBridge(): Bridge {
  let listener: ((command: DesktopCommand) => void) | null = null;
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
  };
  (window as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    platform: "darwin",
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
  });
});

describe("DesktopBridgePublisher", () => {
  it("on the web it queries nothing and publishes nothing", () => {
    render(<DesktopBridgePublisher onOpenPalette={() => undefined} />);
    expect(recentQuery.mock.calls.every(([, options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
    expect(projectQuery.mock.calls.every(([, options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
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
