// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { TrackerScreen, type TrackerScreenProps } from "./tracker-screen";
import { EntriesScreen } from "./entries-screen";
import { CatalogEditProvider } from "./catalog-edit";

const state = {
  running: null,
  projects: [
    {
      id: "p1",
      name: "Website",
      color: "#ef4444",
      clientId: "c1",
      billableDefault: true,
    },
  ],
  clients: [{ id: "c1", name: "Acme", color: "#22c55e" }],
  tasks: [{ id: "t1", name: "Design", color: "#3b82f6" }],
  tags: [],
  compatibility: { apiLevel: 7 },
  favorites: [],
  recents: [
    {
      kind: "recent",
      key: "recent",
      clientId: "c1",
      description: "Landing page",
      projectId: "p1",
      taskId: "t1",
      billable: true,
      projectName: "Website",
      projectColor: "#ef4444",
      projectMissing: false,
      taskMissing: false,
    },
  ],
  settings: { currency: "EUR", durationFormat: "hms" },
  activity: { settings: { enabled: false } },
  workspaces: [],
  heldSync: [],
  pendingIdle: null,
  todaySec: 0,
  syncStatus: "connected",
  pendingSync: 0,
  serverReachable: true,
  webUrl: null,
  email: "tester@example.test",
  profileName: "Test User",
  profileImage: "https://example.test/avatar.png",
  sessionSource: "credentials",
} as unknown as BackgroundState;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const click = async (selector: string) => {
  const element = host.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => element!.click());
};
const render = async (overrides: Partial<BackgroundState> = {}) => {
  const ok = vi.fn(async () => true);
  const onStart = vi.fn(async () => true);
  const onSignOut = vi.fn(async () => true);
  const onUpdateTheme = vi.fn(async () => true);
  const onOpenEntries = vi.fn();
  const props: TrackerScreenProps = {
    state: { ...state, ...overrides },
    error: null,
    onStart,
    onStop: ok,
    onUpdateRunning: ok,
    onPinFavorite: ok,
    onUnpinFavorite: ok,
    onAnswerIdle: ok,
    onOpenSettings: vi.fn(),
    onOpenEntries,
    onUpdateTheme,
    onOpenSuggestions: vi.fn(),
    onSearchDescriptions: vi.fn(),
    onCreateClient: ok,
    onCreateTag: ok,
    onCreateProject: ok,
    onCreateTask: ok,
    onSwitchWorkspace: ok,
    onDiscardHeld: ok,
    onSignOut,
  };
  await act(async () =>
    root.render(
      <CatalogEditProvider
        value={{
          createProject: ok,
          updateProject: ok,
          updateClient: ok,
          updateTag: ok,
          updateTask: ok,
        }}
      >
        <TrackerScreen {...props} />
      </CatalogEditProvider>,
    ),
  );
  return { onStart, onSignOut, onUpdateRunning: ok, onUpdateTheme, onOpenEntries };
};

describe("popup timer controls", () => {
  test("starts a blank timer from the simple opening screen", async () => {
    const { onStart } = await render();
    expect(
      host.querySelector('[data-testid="tracker-description"]'),
    ).toBeNull();
    expect(host.querySelectorAll(".timer-shortcuts button")).toHaveLength(2);
    expect(host.querySelector('[data-testid="tracker-today"]')).toBeNull();
    await click('[data-testid="tracker-start"]');
    expect(onStart).toHaveBeenCalledExactlyOnceWith(
      "",
      null,
      null,
      false,
      [],
      undefined,
    );
  });

  test("Recents drawer starts the selected entry with its independent client", async () => {
    const { onStart } = await render();
    await click('[data-testid="open-recents"]');
    expect(host.querySelector("dialog")?.open).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    await click(".quick__start");
    expect(onStart).toHaveBeenCalledExactlyOnceWith(
      "Landing page",
      "p1",
      "t1",
      true,
      [],
      "c1",
    );
    expect(host.querySelector("dialog")).toBeNull();
  });

  test("Favorites drawer has its own empty state and close button", async () => {
    await render();
    await click('[data-testid="open-favorites"]');
    expect(host.querySelector(".timer-drawer__empty")).not.toBeNull();
    expect(host.querySelector(".quick__start")).toBeNull();
    await click(".timer-drawer__header button");
    expect(host.querySelector("dialog")).toBeNull();
  });

  test("running timer opens its fields and changes client without changing project", async () => {
    const { onUpdateRunning } = await render({
      running: {
        id: "e1",
        description: "Work",
        clientId: "c1",
        projectId: "p1",
        taskId: "t1",
        tagIds: [],
        billable: false,
        start: new Date().toISOString(),
        end: null,
      } as unknown as BackgroundState["running"],
    });
    expect(
      host.querySelector('[data-testid="tracker-description"]'),
    ).not.toBeNull();
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="tracker-client"]')?.value,
    ).toContain("Acme");
    expect(host.querySelectorAll(".combobox__selected-dot")).toHaveLength(3);
    expect(host.querySelector(".billable-glyph .lucide-euro")).not.toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>('[data-testid="tracker-client"]')!.focus());
    const clear = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("No client"));
    expect(clear).toBeDefined();
    await act(async () => clear!.dispatchEvent(new MouseEvent("mousedown", {bubbles: true})));
    expect(onUpdateRunning).toHaveBeenCalledExactlyOnceWith({clientId: null});
    expect(host.querySelector<HTMLInputElement>('[data-testid="tracker-project"]')?.value).toBe("Website");
  });

  test("account avatar replaces footer identity and settings cog", async () => {
    await render();
    const avatar = host.querySelector<HTMLImageElement>('.header .menu__avatar');
    expect(avatar?.getAttribute("src")).toBe("https://example.test/avatar.png");
    expect(host.querySelector('.footer .menu')).toBeNull();
    expect(host.querySelector('.footer__email')).toBeNull();
    expect(host.querySelector('[data-testid="header-settings"]')).toBeNull();
    await act(async () => avatar!.dispatchEvent(new Event("error")));
    expect(host.querySelector('.menu__avatar')?.textContent).toBe("TU");
    await click('[data-testid="menu-trigger"]');
    expect(host.querySelector('[data-testid="menu-settings"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[data-testid="menu-list"]')).toBeNull();
  });

  test("entries navigation lives in the avatar menu", async () => {
    const { onOpenEntries } = await render();
    expect(host.querySelector('[data-testid="header-entries"]')).toBeNull();
    await click('[data-testid="menu-trigger"]');
    await click('[data-testid="menu-entries"]');
    expect(onOpenEntries).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="menu-list"]')).toBeNull();
  });

  test("theme choice persists through account settings and updates the popup", async () => {
    const { onUpdateTheme } = await render();
    await click('[data-testid="theme-toggle"]');
    await click('[data-testid="theme-option-dark"]');
    expect(onUpdateTheme).toHaveBeenCalledWith("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await click('[data-testid="theme-toggle"]');
    await click('[data-testid="theme-option-light"]');
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("running timer has Stop first and tag input before selected tags", async () => {
    await render({
      tags: [{ id: "tag1", name: "Focus", color: "#ef4444" }] as BackgroundState["tags"],
      running: { id: "e1", description: "Work", clientId: null, projectId: null,
        taskId: null, tagIds: ["tag1"], billable: false,
        start: new Date().toISOString(), end: null } as BackgroundState["running"],
    });
    expect(host.querySelector('.popup__body > :first-child')?.getAttribute("data-testid")).toBe("tracker-stop");
    expect(host.querySelector('.timer-shortcuts')).toBeNull();
    const input = host.querySelector('[data-testid="tracker-tags"]')!;
    const cloud = host.querySelector('[data-testid="tracker-tags-selected"]')!;
    expect(input.compareDocumentPosition(cloud) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("embedded history keeps entry navigation and pagination without another header", async () => {
    const onOpenEntry = vi.fn();
    const onLoadMore = vi.fn(async () => true);
    const entry = { id: "past", description: "Earlier work", start: new Date().toISOString(),
      end: new Date().toISOString(), durationSec: 60, projectName: null, clientName: null,
      taskName: null, projectColor: null, invoiceId: null };
    const history = { ...state, entries: { entries: [entry], pendingIds: [], hasMore: true,
      from: new Date().toISOString(), to: new Date().toISOString() } } as unknown as BackgroundState;
    await act(async () => root.render(<EntriesScreen embedded state={history} error={null}
      onBack={vi.fn()} onGoTracker={vi.fn()} onOpenEntry={onOpenEntry}
      onNewEntry={vi.fn()} onLoadMore={onLoadMore} />));
    expect(host.querySelector('.header')).toBeNull();
    await click('[data-testid="entry-row"]');
    expect(onOpenEntry).toHaveBeenCalledWith("past");
    await click('[data-testid="entries-more"]');
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  test("standalone entries keep theme and account navigation", async () => {
    const onOpenSettings = vi.fn();
    const onSignOut = vi.fn(async () => true);
    const onUpdateTheme = vi.fn(async () => true);
    await act(async () => root.render(<EntriesScreen state={state} error={null}
      onBack={vi.fn()} onGoTracker={vi.fn()} onOpenEntry={vi.fn()}
      onNewEntry={vi.fn()} onLoadMore={vi.fn(async () => true)}
      onOpenSettings={onOpenSettings} onSignOut={onSignOut}
      onUpdateTheme={onUpdateTheme} />));
    expect(host.querySelector('.theme-toggle')).not.toBeNull();
    await click('[data-testid="menu-trigger"]');
    await click('[data-testid="menu-settings"]');
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  test("restart shows a running copy before the worker replies and restores the row on failure", async () => {
    let finish!: (value: boolean) => void;
    const onRestartEntry = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const entry = { id: "past", description: "Earlier work", start: new Date().toISOString(),
      end: new Date().toISOString(), durationSec: 60, projectName: null, clientName: null,
      taskName: null, projectColor: null, invoiceId: null };
    const history = { ...state, entries: { entries: [entry], pendingIds: [], hasMore: false,
      from: entry.start, to: entry.end } } as unknown as BackgroundState;
    await act(async () => root.render(<EntriesScreen embedded state={history} error={null}
      onBack={vi.fn()} onGoTracker={vi.fn()} onOpenEntry={vi.fn()}
      onNewEntry={vi.fn()} onRestartEntry={onRestartEntry}
      onLoadMore={vi.fn(async () => true)} />));
    await click('[data-testid="entry-restart"]');
    expect(onRestartEntry).toHaveBeenCalledWith(history.entries!.entries[0]);
    expect(host.querySelector('[data-testid="entry-running"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="entry-restart"]')).toBeNull();
    await act(async () => finish(false));
    expect(host.querySelector('[data-testid="entry-running"]')).toBeNull();
    expect(host.querySelector('[data-testid="entry-restart"]')).not.toBeNull();
  });

  test.each([true, false])("live entry and tally tick together (embedded=%s)", async (embedded) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0));
    try {
      const running = { id: "live", description: "Current work", start: new Date(2026, 9, 1, 11).toISOString(), end: null };
      const past = { ...running, id: "past", description: "Earlier work", end: new Date().toISOString(),
        durationSec: 60, projectName: null, clientName: null, taskName: null, projectColor: null, invoiceId: null };
      const history = { ...state, running, entries: { entries: [past], pendingIds: [], hasMore: false,
        from: past.start, to: past.end } } as unknown as BackgroundState;
      const onGoTracker = vi.fn();
      const show = async () => act(async () => root.render(<EntriesScreen embedded={embedded} state={history} error={null}
        onBack={vi.fn()} onGoTracker={onGoTracker} onOpenEntry={vi.fn()}
        onNewEntry={vi.fn()} onLoadMore={vi.fn(async () => true)} />));
      await show();
      expect(host.querySelectorAll('[data-testid="entry-running"]')).toHaveLength(1);
      expect(host.querySelector('.entry-day__total')?.textContent).toBe("1:01:00");
      await act(async () => vi.advanceTimersByTime(1000));
      expect(host.querySelector('.entry--running .entry__duration')?.textContent).toBe("1:00:01");
      expect(host.querySelector('.entry-day__total')?.textContent).toBe("1:01:01");
      await click('[data-testid="entry-running"]');
      expect(onGoTracker).toHaveBeenCalledOnce();
      history.running = null;
      history.entries!.entries.unshift({ ...history.entries!.entries[0]!, id: "live", durationSec: 3601 });
      await show();
      expect(host.querySelector('[data-testid="entry-running"]')).toBeNull();
      expect(host.querySelector('.entry-day__total')?.textContent).toBe("1:01:01");
    } finally {
      vi.useRealTimers();
    }
  });

  test("overnight running entry creates today's group without finished entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 1, 0, 0));
    try {
      const history = { ...state, running: { id: "live", description: "Overnight",
        start: new Date(2026, 8, 30, 23).toISOString(), end: null },
        entries: { entries: [], pendingIds: [], hasMore: false, from: new Date().toISOString(), to: new Date().toISOString() }
      } as unknown as BackgroundState;
      await act(async () => root.render(<EntriesScreen embedded state={history} error={null}
        onBack={vi.fn()} onGoTracker={vi.fn()} onOpenEntry={vi.fn()}
        onNewEntry={vi.fn()} onLoadMore={vi.fn(async () => true)} />));
      expect(host.querySelector('.entry-day__label')?.textContent).toBe("Today");
      expect(host.querySelector('.entry-day__total')?.textContent).toBe("1:00:00");
      expect(host.querySelector('.entry--running .entry__duration')?.textContent).toBe("2:00:00");
      expect(host.querySelector('[data-testid="entries-empty"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("sign out remains available before the web URL is known", async () => {
    const { onSignOut } = await render();
    await click('[data-testid="menu-trigger"]');
    await click('[data-testid="menu-sign-out"]');
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
