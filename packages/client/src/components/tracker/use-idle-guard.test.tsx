// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_SETTINGS, type TimeEntry } from "@starter/shared";
import type { IdleReading } from "@/hooks/use-idle-signal";
const state = vi.hoisted(() => ({
  workspaceId: "private" as string | null, running: null as TimeEntry | null,
  reading: null as ((reading: IdleReading) => void) | null,
  workspace: new Set<() => void>(), privacy: new Set<() => void>(),
  mutations: { splitAtIdle: vi.fn(), startTimer: vi.fn() }, dismiss: vi.fn(), custom: vi.fn(),
}));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => state.workspaceId, subscribeActiveWorkspace: (fn: () => void) => { state.workspace.add(fn); return () => { state.workspace.delete(fn); }; } }));
vi.mock("@/lib/private-view-lifecycle", () => ({ subscribePrivateViewEpoch: (fn: () => void) => { state.privacy.add(fn); return () => { state.privacy.delete(fn); }; } }));
vi.mock("@/hooks/use-sync", () => ({ useRunningEntry: () => ({ entry: state.running }) }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({ useEntryMutations: () => state.mutations }));
vi.mock("@/hooks/use-catalog-options", () => ({ useProjectOptions: () => ({ data: [] }) }));
vi.mock("@/hooks/use-idle-signal", () => ({ useIdleSignal: (fn: (reading: IdleReading) => void) => { state.reading = fn; } }));
vi.mock("@/lib/format", () => ({ useFormatSettings: () => ({ settings: { idle: { ...DEFAULT_IDLE_SETTINGS, enabled: true, thresholdMinutes: 1, behavior: "pause-and-resume" } }, isLoaded: true, clock: String, durationShort: String }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { dismiss: (...args: unknown[]) => state.dismiss(...args), custom: (...args: unknown[]) => state.custom(...args) } }));
vi.mock("@/lib/desktop-shell", () => ({ notifyDesktop: vi.fn() }));
vi.mock("@/i18n/translate", () => ({ translate: () => (key: string) => key }));
const { idleWatcher, bindIdleWatcherWorkspace } = await import("@/lib/idle-watcher");
const { useIdleGuard } = await import("./use-idle-guard");
const now = Date.parse("2026-10-29T02:00:00.000Z");
function Probe() { useIdleGuard(); return null; }
const entry = () => ({ id: "private-entry", workspaceId: "private", authorId: "owner", description: "Private held description", projectId: null, taskId: null, billable: false, start: new Date(now - 3_600_000).toISOString(), end: null }) as TimeEntry;
beforeEach(() => {
  state.workspaceId = "private"; state.running = null; state.reading = null; state.workspace.clear(); state.privacy.clear();
  state.mutations.startTimer.mockClear(); state.mutations.splitAtIdle.mockClear(); state.dismiss.mockClear(); state.custom.mockClear();
  bindIdleWatcherWorkspace("private"); idleWatcher.reset();
});
afterEach(() => { cleanup(); idleWatcher.reset(); bindIdleWatcherWorkspace(null); vi.restoreAllMocks(); });
it("does not apply a selected workspace's idle policy to a private clock elsewhere", () => {
  state.workspaceId = "standard"; state.running = entry(); idleWatcher.noteLocalStart("private-entry", now - 3_600_000);
  render(<Probe />); act(() => state.reading!({ signal: "idle", atMs: now, idleSinceMs: now - 120_000 }));
  expect(state.mutations.splitAtIdle).not.toHaveBeenCalled(); expect(state.mutations.startTimer).not.toHaveBeenCalled(); expect(idleWatcher.state().ownedEntryId).toBeNull();
});
it("keeps an owned pause/resume working, then discards its private seed on a workspace switch", () => {
  state.running = entry(); idleWatcher.noteLocalStart("private-entry", now - 3_600_000); render(<Probe />);
  act(() => state.reading!({ signal: "idle", atMs: now, idleSinceMs: now - 120_000 }));
  expect(state.mutations.splitAtIdle).toHaveBeenCalledTimes(1); expect(idleWatcher.state().awaitingResume?.description).toBe("Private held description");
  state.running = null; state.workspaceId = "standard"; act(() => { for (const listener of state.workspace) listener(); });
  act(() => state.reading!({ signal: "active", atMs: now + 1000, idleSinceMs: now + 1000 }));
  expect(idleWatcher.state().awaitingResume).toBeNull(); expect(state.mutations.startTimer).not.toHaveBeenCalled(); expect(state.dismiss).toHaveBeenCalledWith("trackyourtime-idle");
});
it("clears a private resume and prompt when the unlock scope changes", () => {
  render(<Probe />);
  idleWatcher.restore({ ...idleWatcher.state(), awaitingResume: { description: "Private held description", projectId: null, taskId: null, billable: false }, pausedEntryId: "private-entry" });
  act(() => { for (const listener of state.privacy) listener(); });
  act(() => state.reading!({ signal: "active", atMs: now, idleSinceMs: now }));
  expect(idleWatcher.state().awaitingResume).toBeNull(); expect(state.mutations.startTimer).not.toHaveBeenCalled(); expect(state.dismiss).toHaveBeenCalledWith("trackyourtime-idle");
});
it("still resumes an owned pause inside the same workspace", () => {
  idleWatcher.restore({ ...idleWatcher.state(), awaitingResume: { description: "Private held description", projectId: null, taskId: null, billable: false }, pausedEntryId: "private-entry" });
  render(<Probe />); act(() => state.reading!({ signal: "active", atMs: now, idleSinceMs: now }));
  expect(state.mutations.startTimer).toHaveBeenCalledWith(expect.objectContaining({ description: "Private held description", start: new Date(now).toISOString() }));
});
