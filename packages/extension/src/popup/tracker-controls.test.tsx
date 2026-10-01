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
  quickStarts: [
    {
      kind: "recent",
      key: "recent",
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
const render = async () => {
  const ok = vi.fn(async () => true);
  const onStart = vi.fn(async () => true);
  const onSignOut = vi.fn(async () => true);
  const props: TrackerScreenProps = {
    state,
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
  return { onStart, onSignOut };
};

describe("popup timer controls", () => {
  test("a preset fills the draft; only the separate Start button starts it", async () => {
    const { onStart } = await render();
    await click(".quick__summary");
    await click(".quick__start");
    expect(onStart).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>(
        '[data-testid="tracker-description"]',
      )?.value,
    ).toBe("Landing page");
    expect(
      host.querySelector('[data-testid="tracker-project-client"]')?.textContent,
    ).toContain("Acme");
    expect(host.querySelectorAll(".combobox__selected-dot")).toHaveLength(2);
    expect(host.querySelector(".billable-glyph .lucide-euro")).not.toBeNull();
    await click('[data-testid="tracker-start"]');
    expect(onStart).toHaveBeenCalledExactlyOnceWith(
      "Landing page",
      "p1",
      "t1",
      true,
      [],
    );
  });

  test("client editor opens the selected project's client field", async () => {
    await render();
    await click(".quick__start");
    await click('[data-testid="tracker-project-client"] button');
    expect(
      host.querySelector('[data-testid="tracker-project-edit-client"]'),
    ).not.toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="tracker-start"]')
        ?.disabled,
    ).toBe(true);
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
