// @vitest-environment jsdom
/**
 * The Autopilot driver: asks main for a plan, makes the write through the
 * tracker's own mutations, reports back with the token and what it wrote,
 * and says so. Nothing at all while Autopilot is off or on the web.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DesktopActivitySnapshot, DesktopAutopilotPlan, TimeEntry } from "@starter/shared";

let shell: "web" | "electron" = "electron";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

const startTimer = vi.fn();
const splitAtIdle = vi.fn();
const stopTimer = vi.fn();
const removeEntry = vi.fn();
vi.mock("@/components/tracker/use-entry-mutations", () => ({
  TRACKER_LIST_INPUT: { from: "2000-01-01", to: "2999-12-31", limit: 50 },
  useEntryMutations: () => ({ startTimer, splitAtIdle, stopTimer, removeEntry }),
}));
let running: TimeEntry | null = null;
vi.mock("@/hooks/use-sync", () => ({ timerStore: { getState: () => ({ running }) } }));
vi.mock("@/lib/offline", () => ({ isNetworkError: () => false, listOwnQueuedMutations: async () => [] }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => "w1" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const custom = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: { custom: (...args: unknown[]) => custom(...args), dismiss: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
const notify = vi.fn(async (_notice: unknown) => true);
vi.mock("@/lib/desktop-shell", () => ({
  notifyDesktop: (notice: unknown) => void notify(notice),
  focusTrackerDescription: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const utils = {
    entries: {
      list: { fetch: async () => ({ entries: [] }), getInfiniteData: () => undefined },
      current: { getData: () => undefined },
    },
  };
  const query = (data: unknown) => ({ useQuery: () => ({ data }) });
  return {
    trpc: {
      useUtils: () => utils,
      projects: { list: query([{ id: "p-web", name: "Website", billableDefault: true }]) },
      tasks: { list: query([]) },
      tags: { list: query([]) },
      settings: { get: query({ userId: "u1" }) },
    },
  };
});

const { DesktopAutopilotDriver } = await import("./autopilot-driver");

const AT = Date.parse("2026-10-19T09:02:00.000Z");

const snapshot = (active: boolean): DesktopActivitySnapshot =>
  ({
    settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14, autopilot: active, autopilotStartMinutes: 5 },
    support: { supported: true },
    autopilot: { active, owned: null, watch: null, log: [], learnedApps: 0 },
  }) as unknown as DesktopActivitySnapshot;

let plans: DesktopAutopilotPlan[] = [];
const applied = vi.fn(async () => undefined);
const learn = vi.fn(async () => undefined);
const planCalls = vi.fn();

const install = (active: boolean): void => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    activity: {
      snapshot: async () => snapshot(active),
      onChanged: () => () => undefined,
      autopilot: {
        learn,
        plan: async (input: unknown) => {
          planCalls(input);
          return plans.shift() ?? { kind: "none" };
        },
        applied,
        hold: vi.fn(async () => undefined),
      },
    },
  };
};

beforeEach(() => {
  shell = "electron";
  running = null;
  plans = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("DesktopAutopilotDriver", () => {
  it("starts the planned timer from when the work began, reports it, and says so", async () => {
    install(true);
    plans = [
      {
        kind: "start",
        token: "tok-1",
        at: AT,
        filing: { key: "k", via: "rule", ruleId: "r1", fields: { description: "Website redesign", projectId: "p-web" } },
        app: { key: "com.figma.desktop", name: "Figma" },
        creditedMs: 6 * 60_000,
      },
    ];
    render(<DesktopAutopilotDriver />);
    await waitFor(() => expect(applied).toHaveBeenCalled());
    expect(learn).toHaveBeenCalled();
    expect(planCalls).toHaveBeenCalledWith({ running: null, tracked: [] });
    expect(startTimer).toHaveBeenCalledWith({
      description: "Website redesign",
      projectId: "p-web",
      taskId: null,
      // The project's default, since the rule names none.
      billable: true,
      tagIds: [],
      start: new Date(AT).toISOString(),
    });
    expect(applied).toHaveBeenCalledWith({
      token: "tok-1",
      ok: true,
      written: { description: "Website redesign", projectId: "p-web", taskId: null },
    });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "autopilot" }));
  });

  it("does not start over a timer that appeared while main was asked", async () => {
    install(true);
    plans = [
      {
        kind: "start",
        token: "tok-2",
        at: AT,
        filing: { key: "k", via: "learned", fields: { description: "Research" } },
        app: { key: "com.google.chrome", name: "Chrome" },
        creditedMs: 6 * 60_000,
      },
    ];
    let calls = 0;
    planCalls.mockImplementation(() => {
      calls += 1;
      // The person starts a timer by hand between the read and the answer.
      running = { id: "e1", start: new Date(AT + 60_000).toISOString() } as TimeEntry;
    });
    render(<DesktopAutopilotDriver />);
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startTimer).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
  });

  it("does nothing while Autopilot is off", async () => {
    install(false);
    render(<DesktopAutopilotDriver />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(planCalls).not.toHaveBeenCalled();
    expect(learn).not.toHaveBeenCalled();
  });

  it("does nothing on the web", async () => {
    shell = "web";
    install(true);
    render(<DesktopAutopilotDriver />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(planCalls).not.toHaveBeenCalled();
  });
});
