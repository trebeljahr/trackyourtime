// @vitest-environment jsdom
/**
 * Whose activity the desktop app records: sent once the person AND the
 * workspace are known, never on a pending session, never on the web.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

let shell: "web" | "electron" = "electron";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

let user: { id: string } | null = null;
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user }) }));
let workspace: { id: string } | null = null;
vi.mock("@/components/members/use-active-workspace", () => ({
  useActiveWorkspace: () => ({ workspace }),
}));

const { DesktopActivityScope } = await import("./desktop-activity-scope");

const setScope = vi.fn(async () => undefined);

beforeEach(() => {
  shell = "electron";
  user = null;
  workspace = null;
  setScope.mockClear();
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    activity: { setScope },
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("DesktopActivityScope", () => {
  it("sends nothing while the session or the workspace is pending", async () => {
    const { rerender } = render(<DesktopActivityScope />);
    user = { id: "u1" };
    rerender(<DesktopActivityScope />);
    await Promise.resolve();
    expect(setScope).not.toHaveBeenCalled();
    user = null;
    workspace = { id: "w1" };
    rerender(<DesktopActivityScope />);
    await Promise.resolve();
    expect(setScope).not.toHaveBeenCalled();
  });

  it("sends the person and the workspace once both are known, and again on a switch", async () => {
    user = { id: "u1" };
    workspace = { id: "w1" };
    const { rerender } = render(<DesktopActivityScope />);
    await waitFor(() => expect(setScope).toHaveBeenCalledWith({ userId: "u1", workspaceId: "w1" }));
    workspace = { id: "w2" };
    rerender(<DesktopActivityScope />);
    await waitFor(() => expect(setScope).toHaveBeenLastCalledWith({ userId: "u1", workspaceId: "w2" }));
  });

  it("keeps the last scope when the session goes pending again", async () => {
    user = { id: "u1" };
    workspace = { id: "w1" };
    const { rerender } = render(<DesktopActivityScope />);
    await waitFor(() => expect(setScope).toHaveBeenCalledTimes(1));
    user = null;
    rerender(<DesktopActivityScope />);
    await Promise.resolve();
    expect(setScope).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the web", async () => {
    shell = "web";
    user = { id: "u1" };
    workspace = { id: "w1" };
    render(<DesktopActivityScope />);
    await Promise.resolve();
    expect(setScope).not.toHaveBeenCalled();
  });
});
