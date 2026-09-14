// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@starter/core";

/**
 * The switcher is invisible to nearly everyone — one workspace — and for the
 * rest it is the only way to change where time is tracked. What these pin:
 * it renders nothing for one workspace, it is a CONTROLLED dialog (so it sits
 * on the overlay stack and Android's back button closes it), and choosing a
 * workspace goes through `switchWorkspace`.
 */

const setActive = vi.fn(async (input: { workspaceId: string }) => input);
vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspaces: {
      setActive: { useMutation: () => ({ mutateAsync: setActive }) },
    },
  },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const { WorkspaceSwitcher } = await import("./workspace-switcher");
const activeWorkspace = await import("@/lib/active-workspace");
const { handleBackPress } = await import("@/mobile/back-button");

const workspace = (id: string, name: string, isDefault = false): WorkspaceSummary => ({
  id,
  name,
  role: isDefault ? "owner" : "member",
  memberCount: isDefault ? 1 : 4,
  isDefault,
  permissions: {
    inviteMembers: false,
    inviteAdmins: false,
    changeRoles: false,
    editTimeVisibility: false,
    editMoneyVisibility: false,
    removeMembers: false,
    transferOwnership: false,
    invoices: false,
    viewOthersTime: false,
    viewOthersMoney: false,
  },
});
const A = workspace("ws-a", "Personal", true);
const B = workspace("ws-b", "Acme");

const renderSwitcher = (queryClient = new QueryClient()) =>
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSwitcher />
    </QueryClientProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
  activeWorkspace.__resetActiveWorkspaceForTests();
  setActive.mockClear();
});

afterEach(cleanup);

describe("WorkspaceSwitcher", () => {
  it("renders nothing for a person in one workspace", async () => {
    await activeWorkspace.applyWorkspaceList([A], "u1");
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before any list is known", () => {
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it("names the active workspace and switches through a dialog", async () => {
    await activeWorkspace.applyWorkspaceList([A, B], "u1");
    const queryClient = new QueryClient();
    queryClient.setQueryData([["entries", "list"], { type: "query" }], ["from Personal"]);
    renderSwitcher(queryClient);

    const trigger = await screen.findByTestId("workspace-switcher");
    expect(trigger).toHaveTextContent("Personal");
    expect(screen.queryByTestId("workspace-switcher-dialog")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const options = await screen.findAllByTestId("workspace-option");
    expect(options).toHaveLength(2);
    expect(options[1]).toHaveTextContent("Acme");
    expect(options[1]).toHaveTextContent("Member · 4 members");

    await act(async () => {
      fireEvent.click(options[1] as HTMLElement);
    });

    await waitFor(() => expect(activeWorkspace.getActiveWorkspaceId()).toBe(B.id));
    expect(setActive).toHaveBeenCalledWith({ workspaceId: B.id });
    expect(queryClient.getQueryData([["entries", "list"], { type: "query" }])).toBeUndefined();
    await waitFor(() =>
      expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("Acme"),
    );
  });

  it("closes on Android's back button", async () => {
    await activeWorkspace.applyWorkspaceList([A, B], "u1");
    renderSwitcher();
    fireEvent.click(await screen.findByTestId("workspace-switcher"));
    expect(await screen.findByTestId("workspace-switcher-dialog")).toBeInTheDocument();

    let handled = false;
    act(() => {
      handled = handleBackPress({ pathname: "/track", navigate: () => undefined });
    });
    expect(handled).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("workspace-switcher-dialog")).not.toBeInTheDocument(),
    );
  });
});
