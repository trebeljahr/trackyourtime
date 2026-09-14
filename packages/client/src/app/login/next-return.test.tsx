// @vitest-environment jsdom
/**
 * Login and signup return somebody to where they were going — an invitation,
 * a device code — and to nowhere else.
 *
 * `?next=` is an open redirect waiting to happen on the one page everybody
 * trusts, so the cases that matter most are the refusals: a protocol-relative
 * host, an absolute URL and a script scheme must all land on the default.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const signInEmail = vi.fn(async () => ({ error: null }));
const signUpEmail = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: (...args: unknown[]) => signInEmail(...(args as [])) },
  signUp: { email: (...args: unknown[]) => signUpEmail(...(args as [])) },
  getSession: vi.fn(async () => ({ data: null })),
  POST_AUTH_REDIRECT: "/track",
}));

const { default: LoginPage } = await import("./page");
const { default: SignupPage } = await import("../signup/page");

const visit = (search: string): void => {
  window.history.replaceState(null, "", `/login/${search}`);
};

const submitLogin = async (): Promise<void> => {
  fireEvent.change(screen.getByTestId("login-email"), {
    target: { value: "bob@example.com" },
  });
  fireEvent.change(screen.getByTestId("login-password"), {
    target: { value: "hunter22hunter" },
  });
  fireEvent.click(screen.getByTestId("login-submit"));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
};

const submitSignup = async (): Promise<void> => {
  fireEvent.change(screen.getByTestId("signup-name"), { target: { value: "Bob" } });
  fireEvent.change(screen.getByTestId("signup-email"), {
    target: { value: "bob@example.com" },
  });
  fireEvent.change(screen.getByTestId("signup-password"), {
    target: { value: "hunter22hunter" },
  });
  fireEvent.change(screen.getByTestId("signup-confirm-password"), {
    target: { value: "hunter22hunter" },
  });
  fireEvent.click(screen.getByTestId("signup-submit"));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
};

beforeEach(() => {
  replace.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("login ?next=", () => {
  it("returns to the invitation after signing in", async () => {
    visit(`?next=${encodeURIComponent("/invite/?id=inv1")}`);
    render(<LoginPage />);
    await submitLogin();
    expect(replace).toHaveBeenCalledWith("/invite/?id=inv1");
  });

  it("keeps a device code through sign-in", async () => {
    visit(`?next=${encodeURIComponent("/device/?user_code=ABCD-EFGH")}`);
    render(<LoginPage />);
    await submitLogin();
    expect(replace).toHaveBeenCalledWith("/device/?user_code=ABCD-EFGH");
  });

  it.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "/reports",
  ])("ignores next=%s and goes to /track", async (next) => {
    visit(`?next=${encodeURIComponent(next)}`);
    render(<LoginPage />);
    await submitLogin();
    expect(replace).toHaveBeenCalledWith("/track");
  });

  it("prefills the email and carries next over to signup", async () => {
    visit(
      `?next=${encodeURIComponent("/invite/?id=inv1")}&email=${encodeURIComponent(
        "bob@example.com",
      )}`,
    );
    render(<LoginPage />);
    await waitFor(() =>
      expect(screen.getByTestId("login-email")).toHaveValue("bob@example.com"),
    );
    const href = screen.getByTestId("login-to-signup").getAttribute("href") ?? "";
    const url = new URL(href, "https://app.test");
    // next/link applies `trailingSlash` from the build config, which a unit
    // test does not load — so either spelling of the route is the same page.
    expect(url.pathname).toMatch(/^\/signup\/?$/);
    expect(url.searchParams.get("next")).toBe("/invite/?id=inv1");
  });

  it("does not forward an unsafe next to signup", async () => {
    visit(`?next=${encodeURIComponent("//evil.com")}`);
    render(<LoginPage />);
    const link = await screen.findByTestId("login-to-signup");
    expect(link.getAttribute("href")).not.toContain("evil");
  });
});

describe("signup ?next=", () => {
  it("returns to the invitation after creating the account", async () => {
    visit(
      `?next=${encodeURIComponent("/invite/?id=inv1")}&email=${encodeURIComponent(
        "bob@example.com",
      )}`,
    );
    render(<SignupPage />);
    await waitFor(() =>
      expect(screen.getByTestId("signup-email")).toHaveValue("bob@example.com"),
    );
    await submitSignup();
    expect(replace).toHaveBeenCalledWith("/invite/?id=inv1");
  });

  it("ignores an absolute URL", async () => {
    visit(`?next=${encodeURIComponent("https://evil.com/invite")}`);
    render(<SignupPage />);
    await submitSignup();
    expect(replace).toHaveBeenCalledWith("/track");
  });
});
