// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { TrackerScreen, type TrackerScreenProps } from "./tracker-screen";
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
    onOpenEntries: vi.fn(),
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
  return { onStart, onSignOut, onUpdateRunning: ok };
};

describe("popup timer controls", () => {
  test("starts a blank timer from the simple opening screen", async () => {
    const { onStart } = await render();
    expect(
      host.querySelector('[data-testid="tracker-description"]'),
    ).toBeNull();
    expect(host.querySelectorAll(".timer-shortcuts button")).toHaveLength(2);
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

  test("running timer opens its fields and client picker", async () => {
    await render({
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

  test("sign out remains available before the web URL is known", async () => {
    const { onSignOut } = await render();
    await click('[data-testid="menu-trigger"]');
    await click('[data-testid="menu-sign-out"]');
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
