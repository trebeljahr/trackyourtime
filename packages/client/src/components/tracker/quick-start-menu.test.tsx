// @vitest-environment jsdom
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EntryMutations } from "./use-entry-mutations";

const { start, pin } = vi.hoisted(() => ({ start: vi.fn(), pin: vi.fn() }));
vi.mock("@/i18n/use-t", () => ({ useT: () => (key: string) => key }));
vi.mock("@/hooks/use-favorites", () => ({
  useQuickStarts: () => ({
    isLoading: false,
    items: [
      { kind: "recent", key: "recent", description: "Yesterday's work", projectId: null, taskId: null, clientId: null, tagIds: [], billable: false },
      { kind: "favorite", id: "favorite", description: "Pinned work", projectId: null, taskId: null, clientId: null, tagIds: [], billable: false },
    ],
    pin, unpin: vi.fn(), move: vi.fn(),
  }),
}));
import { QuickStartMenu } from "./quick-start-menu";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows only recent work in Recent and starts the selected entry", () => {
  render(<QuickStartMenu mutations={{ startQuickStart: start } as unknown as EntryMutations} />);
  expect(screen.queryByTestId("quick-start-trigger")).toBeNull();
  fireEvent.keyDown(screen.getByTestId("recent-start-trigger"), { key: "Enter" });
  expect(screen.queryByText("Pinned work")).toBeNull();
  fireEvent.click(screen.getByText("Yesterday's work"));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ description: "Yesterday's work" }));
});

it("shows only pinned work in Favorites", () => {
  render(<QuickStartMenu mutations={{ startQuickStart: start } as unknown as EntryMutations} />);
  fireEvent.keyDown(screen.getByTestId("favorite-start-trigger"), { key: "Enter" });
  expect(screen.getByText("Pinned work")).toBeTruthy();
  expect(screen.queryByText("Yesterday's work")).toBeNull();
});
