// @vitest-environment jsdom
/**
 * ProtectedLayout sits on every protected route, and stage 1 added a new
 * `!sessionReady` term to its Loading gate. On web that flag has to be true
 * from the first render — `hydrateNativeSession()` returns before its first
 * await when `isNative()` is false — or every signed-in web user would sit on
 * "Loading..." forever. Nothing exercised that, so it is asserted here against
 * the real `useNativeSession` and the real `native-session` store rather than
 * a mock of either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const useAuth = vi.fn();
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => useAuth() }));

const getSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({ getSession: () => getSession() }));

// AppShell drags in the whole nav, the tracker bar and tRPC. What is under
// test is which of the three branches the layout takes, so stand in for it.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

const { default: ProtectedLayout } = await import("./layout");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderLayout = () =>
  render(
    <ProtectedLayout>
      <p>protected content</p>
    </ProtectedLayout>,
  );

describe("ProtectedLayout on web", () => {
  it("does not get stuck on Loading waiting for a native session", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    renderLayout();

    // `sessionReady` is only ever set by the native-session store. If it were
    // false on web this would never resolve.
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    });
    expect(screen.getByText("protected content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    // The cached session was enough; no server round trip was needed.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("shows Loading while the auth hook is still resolving", () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });

    renderLayout();

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("rechecks with the server before redirecting, and stays in when it answers", async () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({
      data: { session: { id: "s1" } },
      error: null,
    });

    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to /login only on a clean null from the server", async () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("does not sign a web user out because the request failed", async () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    // No stored token on web, so a rejection is still a sign-out — that is
    // the pre-stage-1 behaviour and the point is that it is unchanged.
    getSession.mockRejectedValue(new Error("network down"));

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
  });

  it("carries the page being visited as ?next= so sign-in comes back to it", async () => {
    // The device-approval code used to be lost here: /device/?user_code=…
    // signed in and landed on /track with nothing to approve.
    window.history.replaceState(null, "", "/device/?user_code=ABCD-EFGH");
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });
    const target = new URL(String(replace.mock.calls[0]?.[0]), "https://app.test");
    expect(target.pathname).toBe("/login/");
    expect(target.searchParams.get("next")).toBe("/device/?user_code=ABCD-EFGH");
    window.history.replaceState(null, "", "/");
  });

  it("does not forward a page outside the return allowlist", async () => {
    window.history.replaceState(null, "", "/reports/?from=2026-01-01");
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
    window.history.replaceState(null, "", "/");
  });
});
