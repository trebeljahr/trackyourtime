// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { TrackerScreen, type TrackerScreenProps } from "./tracker-screen";
import { TimeField } from "./time-field";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const type = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (input: HTMLInputElement, value: string): void => {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
};

test("the start-time field is editable immediately after Start, before the worker answers", async () => {
  let finish!: (saved: boolean) => void;
  const props: TrackerScreenProps = {
    state: {
      running: null, projects: [], clients: [], tags: [], tasks: [], quickStarts: [],
      workspaces: [], heldSync: [], settings: null, pendingIdle: null, todaySec: 0,
      pendingSync: 0, webUrl: null, email: "test@example.com", serverReachable: true,
      syncStatus: "connected", descriptions: [], descriptionsFor: "",
      activity: { settings: { enabled: false } },
    } as unknown as BackgroundState,
    error: null,
    onStart: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; })),
    onUpdateRunning: vi.fn(async () => true),
    onStop: vi.fn(async () => true), onPinFavorite: vi.fn(async () => true),
    onUnpinFavorite: vi.fn(async () => true), onAnswerIdle: vi.fn(async () => true),
    onOpenSettings: vi.fn(), onOpenEntries: vi.fn(), onOpenSuggestions: vi.fn(),
    onSearchDescriptions: vi.fn(), onCreateClient: vi.fn(async () => true),
    onCreateTag: vi.fn(async () => true), onCreateProject: vi.fn(async () => true),
    onCreateTask: vi.fn(async () => true), onSwitchWorkspace: vi.fn(async () => true),
    onDiscardHeld: vi.fn(async () => true),
  };
  await act(async () => root.render(<TrackerScreen {...props} />));
  expect(container.querySelector('[data-testid="tracker-start-time"]')).toBeNull();
  await act(async () => (container.querySelector('[data-testid="tracker-start"]') as HTMLButtonElement).click());
  const input = container.querySelector('[data-testid="tracker-start-time"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  expect(input.disabled).toBe(false);
  await act(async () => { input.focus(); type(input, "08:15"); });
  await act(async () => key(input, "Enter"));
  expect(props.onUpdateRunning).toHaveBeenCalledExactlyOnceWith({ start: expect.any(String) });
  expect(props.onStop).not.toHaveBeenCalled();
  await act(async () => finish(true));
});

test("Enter saves once in the entry's zone, Escape cancels, and an untouched field keeps its seconds", async () => {
  const onCommit = vi.fn();
  await act(async () => root.render(<TimeField label="Start time" value="2026-09-30T09:30:42.000Z"
    zone="UTC" timeFormat="24h" onCommit={onCommit} testId="start-time" />));
  const input = container.querySelector("input")!;
  await act(async () => { input.focus(); input.blur(); });
  expect(onCommit).not.toHaveBeenCalled();
  await act(async () => { input.focus(); type(input, "08:15"); });
  await act(async () => key(input, "Escape"));
  expect(onCommit).not.toHaveBeenCalled();
  expect(input.value).toBe("09:30");
  await act(async () => { input.focus(); type(input, "08:15"); });
  await act(async () => key(input, "Enter"));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("2026-09-30T08:15:00.000Z");
});
