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
vi.mock("@/lib/auth-client", () => ({
  // Arguments forwarded: whether the recheck bypasses better-auth's cookie
  // cache is the difference between noticing a deleted account and not.
  getSession: (options?: unknown) => getSession(options),
}));

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
    getSession.mockResolvedValue({ data: { session: { id: "s1" } }, error: null });

    renderLayout();

    // `sessionReady` is only ever set by the native-session store. If it were
    // false on web this would never resolve.
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    });
    expect(screen.getByText("protected content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders the app at once when a session is already in hand", async () => {
    // The confirmation below can only take a user out, so it must not put a
    // loading screen in front of every protected page load while it runs.
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    getSession.mockReturnValue(new Promise(() => {}));

    renderLayout();

    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("confirms a session in hand with the cookie cache off", async () => {
    // better-auth answers `/get-session` from a five-minute signed cookie, so
    // a cached session outlives the account it belongs to. Asking with the
    // cache on would keep a deleted account inside the app for that long.
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    getSession.mockResolvedValue({ data: { session: { id: "s1" } }, error: null });

    renderLayout();

    await waitFor(() => {
      expect(getSession).toHaveBeenCalledWith({
        query: { disableCookieCache: true },
      });
    });
  });

  it("signs out a session the server no longer has", async () => {
    // The account was deleted on another device. The session hook still says
    // signed in, out of the cookie cache; the server says otherwise.
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("keeps a signed-in user in when the confirmation cannot be made", async () => {
    // A 502 mid-redeploy, or a dead network. Nothing has said the session is
    // gone, and the session in hand is the evidence it is not.
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    getSession.mockRejectedValue(new Error("network down"));

    renderLayout();

    await waitFor(() => {
      expect(getSession).toHaveBeenCalled();
    });
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
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
    // The device-approval code used to be lost here: /app/device/?user_code=…
    // signed in and landed on /app/track with nothing to approve.
    window.history.replaceState(null, "", "/app/device/?user_code=ABCD-EFGH");
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });
    const target = new URL(String(replace.mock.calls[0]?.[0]), "https://app.test");
    expect(target.pathname).toBe("/login/");
    expect(target.searchParams.get("next")).toBe("/app/device/?user_code=ABCD-EFGH");
    window.history.replaceState(null, "", "/");
  });

  it("does not forward a page outside the return allowlist", async () => {
    window.history.replaceState(null, "", "/app/reports/?from=2026-01-01");
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    getSession.mockResolvedValue({ data: null, error: null });

    renderLayout();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
    window.history.replaceState(null, "", "/");
  });
});
