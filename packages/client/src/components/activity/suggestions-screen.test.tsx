// @vitest-environment jsdom
/**
 * The activity screen: a web notice in the prerender and in a browser, the
 * desktop screen after hydration, and every action through the bridge.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type {
  DesktopActivity,
  DesktopActivitySnapshot,
  DesktopActivitySuggestion,
} from "@starter/shared";

let shell: "web" | "electron" = "web";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

const createManualEntry = vi.fn();
vi.mock("@/components/tracker/use-entry-mutations", () => ({
  TRACKER_LIST_INPUT: { from: "2000-01-01", to: "2999-12-31", limit: 50 },
  useEntryMutations: () => ({ createManualEntry }),
}));
vi.mock("@/hooks/use-sync", () => ({ timerStore: { getState: () => ({ running: null }) } }));
vi.mock("@/lib/offline", () => ({
  isNetworkError: () => false,
  listOwnQueuedMutations: async () => [],
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => "w1" }));
const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: (m: string) => toastInfo(m), error: vi.fn() } }));

const listFetch = vi.fn(async () => ({ entries: [] as unknown[] }));
vi.mock("@/lib/trpc", () => {
  const utils = {
    entries: {
      list: { fetch: () => listFetch(), getInfiniteData: () => undefined },
      current: { getData: () => null },
    },
  };
  const query = (data: unknown) => ({ useQuery: () => ({ data }) });
  return {
    trpc: {
      useUtils: () => utils,
      projects: { list: query([{ id: "p1", name: "Website", billableDefault: true, clientName: null }]) },
      tasks: { list: query([]) },
      tags: { list: query([]) },
      settings: { get: query(undefined) },
    },
  };
});

const { SuggestionsScreen } = await import("./suggestions-screen");

const HOUR = 3_600_000;
const T0 = Date.now() - 3 * HOUR;

const suggestion = (over: Partial<DesktopActivitySuggestion> = {}): DesktopActivitySuggestion => ({
  start: T0,
  end: T0 + 25 * 60_000,
  topApps: [
    { key: "com.example.editor", name: "Editor", seconds: 1_200, share: 0.8 },
    { key: "com.example.chat", name: "Chat", seconds: 300, share: 0.2 },
  ],
  titles: [],
  proposed: { projectId: "p1", description: "Site" },
  ...over,
});

const snapshot: DesktopActivitySnapshot = {
  settings: { enabled: true, storeTitles: false, excludedApps: [], retentionDays: 14 },
  support: { supported: true },
  titlesAvailable: false,
  scoped: true,
  recording: true,
  storedSegments: 3,
  recentApps: [{ key: "com.example.editor", name: "Editor" }],
  rules: [],
};

const bridge = (list: DesktopActivitySuggestion[]) => {
  const activity = {
    snapshot: vi.fn(async () => snapshot),
    onChanged: vi.fn(() => () => undefined),
    updateSettings: vi.fn(async () => snapshot),
    setScope: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    wipe: vi.fn(async () => snapshot),
    suggestions: vi.fn(async () => list),
    checkAccept: vi.fn(async ({ start, end }: { start: number; end: number }) => ({ ok: true as const, start, end })),
    markAccepted: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => true),
    addRule: vi.fn(async () => []),
    removeRule: vi.fn(async () => []),
  } satisfies DesktopActivity;
  return activity;
};

const install = (activity: DesktopActivity | undefined): void => {
  (window as unknown as { electronAPI?: unknown }).electronAPI =
    activity === undefined ? undefined : { isDesktop: true, activity };
};

beforeEach(() => {
  shell = "web";
  createManualEntry.mockClear();
  toastInfo.mockClear();
  install(undefined);
});

afterEach(() => {
  cleanup();
  install(undefined);
});

describe("SuggestionsScreen", () => {
  it("prerenders the same notice with and without the desktop bridge", () => {
    const web = renderToString(<SuggestionsScreen />);
    shell = "electron";
    install(bridge([suggestion()]));
    const desktop = renderToString(<SuggestionsScreen />);
    expect(desktop).toBe(web);
    expect(web).toContain('data-testid="activity-web-notice"');
  });

  it("stays the notice in a browser", () => {
    render(<SuggestionsScreen />);
    expect(screen.getByTestId("activity-web-notice")).toBeInTheDocument();
  });

  it("shows the cards by app name after hydration in the desktop app", async () => {
    shell = "electron";
    const activity = bridge([suggestion()]);
    install(activity);
    render(<SuggestionsScreen />);
    const card = await screen.findByTestId("activity-suggestion");
    expect(screen.getByTestId("activity-suggestion-apps")).toHaveTextContent("Editor 80%");
    expect(screen.getByTestId("activity-suggestion-apps")).toHaveTextContent("Chat 20%");
    expect(screen.getByTestId("activity-suggestion-proposal")).toHaveTextContent("Files under Website");
    expect(card).toBeInTheDocument();
    expect(activity.suggestions).toHaveBeenCalledWith(expect.objectContaining({ tracked: [] }));
  });

  it("adds through the accept check and createManualEntry, then marks the span accepted", async () => {
    shell = "electron";
    const activity = bridge([suggestion()]);
    install(activity);
    render(<SuggestionsScreen />);
    fireEvent.click(await screen.findByTestId("activity-suggestion-add"));
    await waitFor(() => expect(activity.markAccepted).toHaveBeenCalled());
    expect(activity.checkAccept).toHaveBeenCalledWith(
      expect.objectContaining({ start: T0, end: T0 + 25 * 60_000, edited: false }),
    );
    expect(createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Site", projectId: "p1", billable: true }),
    );
  });

  it("creates nothing when the time was tracked meanwhile", async () => {
    shell = "electron";
    const activity = bridge([suggestion()]);
    activity.checkAccept.mockResolvedValueOnce({ ok: false, reason: "already-tracked" } as never);
    install(activity);
    render(<SuggestionsScreen />);
    fireEvent.click(await screen.findByTestId("activity-suggestion-add"));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("That time is already tracked or dismissed."));
    expect(createManualEntry).not.toHaveBeenCalled();
  });

  it("dismisses the exact span", async () => {
    shell = "electron";
    const activity = bridge([suggestion()]);
    install(activity);
    render(<SuggestionsScreen />);
    fireEvent.click(await screen.findByTestId("activity-suggestion-dismiss"));
    await waitFor(() => expect(activity.dismiss).toHaveBeenCalledWith({ start: T0, end: T0 + 25 * 60_000 }));
  });

  it("says capture is off and links to the desktop settings", async () => {
    shell = "electron";
    const activity = bridge([]);
    activity.snapshot.mockResolvedValue({ ...snapshot, settings: { ...snapshot.settings, enabled: false } });
    install(activity);
    render(<SuggestionsScreen />);
    expect(await screen.findByTestId("activity-status")).toHaveAttribute("data-status", "off");
    expect(await screen.findByTestId("activity-empty")).toBeInTheDocument();
  });
});
