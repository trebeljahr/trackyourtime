import { describe, expect, it, vi } from "vitest";
import type { TimeEntry } from "@starter/shared";

import { runPaletteAction, type PaletteRunner } from "./palette-actions";

const running = {
  id: "e1",
  description: "Writing",
  projectId: null,
  taskId: null,
  billable: false,
  start: "2026-09-01T09:00:00.000Z",
  end: null,
  tagIds: [],
} as unknown as TimeEntry;

const runner = (overrides: Partial<PaletteRunner> = {}) => {
  const mutations = {
    startTimer: vi.fn(),
    startQuickStart: vi.fn(),
    stopTimer: vi.fn(),
    removeEntry: vi.fn(),
  };
  const value = {
    mutations,
    navigate: vi.fn(),
    running,
    close: vi.fn(),
    setPage: vi.fn(),
    ...overrides,
  };
  return value;
};

describe("runPaletteAction", () => {
  it("stops through the tracker's mutation and closes", () => {
    const r = runner();
    runPaletteAction({ kind: "stop" }, r);
    expect(r.mutations.stopTimer).toHaveBeenCalledWith();
    expect(r.close).toHaveBeenCalled();
  });

  it("starts with the row's fields", () => {
    const r = runner();
    const fields = {
      description: "",
      projectId: "p1",
      taskId: null,
      billable: true,
      tagIds: [],
    };
    runPaletteAction({ kind: "start", fields }, r);
    expect(r.mutations.startTimer).toHaveBeenCalledWith(fields);
    expect(r.close).toHaveBeenCalled();
  });

  it("starts a quick start", () => {
    const r = runner();
    const quick = {
      description: "Review",
      projectId: null,
      taskId: null,
      billable: false,
    };
    runPaletteAction({ kind: "quick-start", quick }, r);
    expect(r.mutations.startQuickStart).toHaveBeenCalledWith(quick);
  });

  it("asks before discarding, and only the confirmation deletes", () => {
    const r = runner();
    runPaletteAction({ kind: "discard-confirm" }, r);
    expect(r.setPage).toHaveBeenCalledWith("discard");
    expect(r.mutations.removeEntry).not.toHaveBeenCalled();
    expect(r.close).not.toHaveBeenCalled();

    runPaletteAction({ kind: "discard" }, r);
    expect(r.mutations.removeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
    );
    expect(r.close).toHaveBeenCalled();
  });

  it("discards nothing when the timer stopped meanwhile", () => {
    const r = runner({ running: null });
    runPaletteAction({ kind: "discard" }, r);
    expect(r.mutations.removeEntry).not.toHaveBeenCalled();
    expect(r.close).toHaveBeenCalled();
  });

  it("goes back from the confirmation", () => {
    const r = runner();
    runPaletteAction({ kind: "back" }, r);
    expect(r.setPage).toHaveBeenCalledWith("root");
  });

  it("navigates and closes", () => {
    const r = runner();
    runPaletteAction({ kind: "navigate", href: "/projects" }, r);
    expect(r.close).toHaveBeenCalled();
    expect(r.navigate).toHaveBeenCalledWith("/projects");
  });
});
