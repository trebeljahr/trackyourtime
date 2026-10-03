// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetailedEntry } from "@starter/shared";
let userId = "me";
let workspaceId = "here";
let canView = true;
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: userId } }) }));
vi.mock("@/components/workspace-switcher", () => ({ useActiveWorkspace: () => ({ activeId: workspaceId }) }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: workspaceId, permissions: { viewOthersTime: canView } } }) }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://time.example" }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({ useEntryMutations: () => ({}) }));
vi.mock("@/components/tracker/entry-edit-dialog", () => ({ EntryEditDialog: ({ entry }: { entry: DetailedEntry }) => <div data-testid="actual-entry-editor">{entry.id}</div> }));
import { SearchEntryDialog } from "./search-entry-dialog";
const entry = { id: "actual-id", workspaceId: "here", authorId: "me", description: "Precise entry", start: "2026-10-03T10:00:00Z", end: null, durationSec: 0, projectName: "Project", taskName: "Task" } as DetailedEntry;
afterEach(() => { cleanup(); userId = "me"; workspaceId = "here"; canView = true; });

describe("search entry selection", () => {
  it("opens the actual matching entry editor for its author", () => {
    render(<SearchEntryDialog selected={{ entry, userId: "me", server: "https://time.example" }} onClose={() => {}} />);
    expect(screen.getByTestId("actual-entry-editor")).toHaveTextContent("actual-id");
  });
  it("renders colleagues' entries read-only and withdraws them after a visibility change", () => {
    const selected = { entry: { ...entry, authorId: "colleague" }, userId: "me", server: "https://time.example" };
    const rendered = render(<SearchEntryDialog selected={selected} onClose={() => {}} />);
    expect(screen.getByTestId("search-entry-details")).toHaveTextContent("Precise entry");
    expect(screen.queryByTestId("actual-entry-editor")).not.toBeInTheDocument();
    canView = false; rendered.rerender(<SearchEntryDialog selected={selected} onClose={() => {}} />);
    expect(screen.queryByTestId("search-entry-details")).not.toBeInTheDocument();
  });
  it("hides the selected entry when user, server or workspace no longer matches", () => {
    const selected = { entry, userId: "me", server: "https://time.example" };
    const rendered = render(<SearchEntryDialog selected={selected} onClose={() => {}} />);
    userId = "other"; rendered.rerender(<SearchEntryDialog selected={selected} onClose={() => {}} />);
    expect(screen.queryByTestId("actual-entry-editor")).not.toBeInTheDocument();
    userId = "me"; workspaceId = "other"; rendered.rerender(<SearchEntryDialog selected={selected} onClose={() => {}} />);
    expect(screen.queryByTestId("actual-entry-editor")).not.toBeInTheDocument();
    workspaceId = "here"; rendered.rerender(<SearchEntryDialog selected={{ ...selected, server: "https://other.example" }} onClose={() => {}} />);
    expect(screen.queryByTestId("actual-entry-editor")).not.toBeInTheDocument();
  });
});
