// @vitest-environment jsdom
/**
 * The workspace the membership screens show is the one requests are addressed
 * to. Reading the session default instead would, after a switch, draw the
 * Members screen and the Reports member filter from one workspace's
 * permissions while every request went to another.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { ACTIVE_WORKSPACE_STORAGE_KEY } from "@starter/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workspaceFor } from "./member-fixtures";

const personal = workspaceFor("owner", { id: "ws-personal", name: "Mine", memberCount: 1 });
const team = workspaceFor("member", { id: "ws-team", name: "Team", isDefault: false });
const list = [personal, team];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspaces: {
      list: {
        useQuery: () => ({
          data: list,
          isPending: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

const activeWorkspace = await import("@/lib/active-workspace");
const { useActiveWorkspace } = await import("./use-active-workspace");
const { enterWorkspace } = await import("./enter-workspace");

beforeEach(async () => {
  window.localStorage.clear();
  activeWorkspace.__resetActiveWorkspaceForTests();
  await activeWorkspace.applyWorkspaceList(list, "u1");
});

afterEach(cleanup);

describe("useActiveWorkspace (membership screens)", () => {
  it("shows the default before anything was chosen", () => {
    const { result } = renderHook(() => useActiveWorkspace());
    expect(result.current.workspace?.id).toBe("ws-personal");
  });

  it("follows a switch to a workspace that is not the default", async () => {
    const { result } = renderHook(() => useActiveWorkspace());
    await act(async () => {
      await activeWorkspace.switchWorkspace("ws-team", {
        queryClient: new QueryClient(),
      });
    });
    await waitFor(() => expect(result.current.workspace?.id).toBe("ws-team"));
    expect(result.current.workspace?.role).toBe("member");
  });
});

describe("enterWorkspace", () => {
  it("stores the choice through the active-workspace store, then navigates", async () => {
    const navigate = vi.fn();
    await enterWorkspace("ws-team", navigate);
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-team");
    expect(activeWorkspace.getActiveWorkspaceId()).toBe("ws-team");
    expect(navigate).toHaveBeenCalledWith("/track/");
  });

  it("stores a workspace the known list does not contain yet (just joined)", async () => {
    const navigate = vi.fn();
    await enterWorkspace("ws-new", navigate);
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-new");
    expect(navigate).toHaveBeenCalledWith("/track/");
  });
});
