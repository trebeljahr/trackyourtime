// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StartupTiming } from "./startup-timing";

const mock = vi.hoisted(() => ({ state: { isAuthenticated: false, isLoading: true }, ready: vi.fn(), reset: vi.fn() }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => mock.state }));
vi.mock("@/lib/startup-timing", () => ({ markAuthenticationReady: mock.ready, resetStartupTiming: mock.reset }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mock.state = { isAuthenticated: false, isLoading: true }; });

describe("auth milestone observer", () => {
  it("waits for resolved auth, resets on signout, and preserves a pending login", () => {
    const view = render(<StartupTiming />);
    expect(mock.ready).not.toHaveBeenCalled();
    mock.state = { isAuthenticated: true, isLoading: true };
    view.rerender(<StartupTiming />);
    expect(mock.ready).not.toHaveBeenCalled();
    mock.state = { isAuthenticated: true, isLoading: false };
    view.rerender(<StartupTiming />);
    expect(mock.ready).toHaveBeenCalledTimes(1);
    mock.state = { isAuthenticated: false, isLoading: false };
    view.rerender(<StartupTiming />);
    expect(mock.reset).toHaveBeenCalledTimes(1);
    view.rerender(<StartupTiming />);
    expect(mock.reset).toHaveBeenCalledTimes(1);
  });
  it("does not mark anonymous or failed auth as ready", () => {
    mock.state = { isAuthenticated: false, isLoading: false };
    render(<StartupTiming />);
    expect(mock.ready).not.toHaveBeenCalled();
    expect(mock.reset).not.toHaveBeenCalled();
  });
});
