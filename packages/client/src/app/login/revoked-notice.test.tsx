// @vitest-environment jsdom
/**
 * The login screen has to answer "why am I looking at you?".
 *
 * A device signed out from Settings → Devices is redirected here without the
 * person at it having touched anything. The toast fired during the redirect
 * has four seconds and may go off while the phone is in a pocket, so the
 * screen itself carries the reason — and the count of unsent changes still
 * held on the device, which is the part that decides whether the user thinks
 * their afternoon has been lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  signIn: { email: vi.fn() },
  getSession: vi.fn(),
  isTwoFactorChallenge: () => false,
  webCallbackUrl: (path: string) => path,
  POST_AUTH_REDIRECT: "/track",
}));

// Reads the server's auth config over tRPC; covered by its own test.
vi.mock("@/components/google-sign-in-button", () => ({
  GoogleSignInButton: () => null,
}));

const { default: LoginPage } = await import("./page");
const { __resetSessionRevokedForTests, handleSessionRevoked } = await import(
  "@/lib/session-revoked"
);

const revoke = (pending: number) =>
  handleSessionRevoked({
    pendingCount: async () => pending,
    signOut: async () => undefined,
    clearToken: async () => undefined,
    notify: () => undefined,
    redirect: () => undefined,
  });

beforeEach(() => {
  __resetSessionRevokedForTests();
});

afterEach(() => {
  cleanup();
});

describe("the login screen after a revocation", () => {
  it("says nothing when the user simply navigated here", async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByTestId("login-submit")).toBeTruthy();
    });
    expect(screen.queryByTestId("login-revoked")).toBeNull();
  });

  it("explains the sign-out and accounts for the unsent changes", async () => {
    await revoke(3);

    render(<LoginPage />);

    const notice = await screen.findByTestId("login-revoked");
    expect(notice.textContent).toContain("You were signed out");
    expect(notice.textContent).toContain("3 unsent changes are still saved");
  });

  it("does not claim a queue that is empty", async () => {
    await revoke(0);

    render(<LoginPage />);

    const notice = await screen.findByTestId("login-revoked");
    expect(notice.textContent).toContain("Sign in again to continue");
    expect(notice.textContent).not.toContain("unsent");
  });
});
