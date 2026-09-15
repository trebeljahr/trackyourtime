// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountLinks } from "@/components/marketing/account-links";

const auth = vi.hoisted(() => ({ isAuthenticated: false, isLoading: false }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => auth }));

const LABELS = { logIn: "Log in", createAccount: "Create an account", openApp: "Open the app" };

describe("AccountLinks", () => {
  afterEach(cleanup);

  beforeEach(() => {
    auth.isAuthenticated = false;
    auth.isLoading = false;
  });

  it("offers sign-in and signup to a visitor", () => {
    render(<AccountLinks {...LABELS} />);
    expect(screen.getByTestId("marketing-log-in").getAttribute("href")).toMatch(/^\/login\/?$/);
    expect(screen.queryByTestId("marketing-open-app")).toBeNull();
  });

  it("links a signed-in person into the app instead of redirecting them", () => {
    auth.isAuthenticated = true;
    render(<AccountLinks {...LABELS} />);
    expect(screen.getByTestId("marketing-open-app").getAttribute("href")).toMatch(/^\/app\/track\/?$/);
    expect(screen.queryByTestId("marketing-log-in")).toBeNull();
  });

  it("prerenders the signed-out links even with a session, so hydration matches", () => {
    auth.isAuthenticated = true;
    const html = renderToString(<AccountLinks {...LABELS} />);
    expect(html).toContain('data-testid="marketing-log-in"');
    expect(html).not.toContain("marketing-open-app");
  });
});
