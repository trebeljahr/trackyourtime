// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const fake = vi.hoisted(() => ({
  signIn: vi.fn(async () => ({ error: null })),
  listeners: new Set<() => void>(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: fake.signIn }, authClient: {}, getSession: async () => undefined,
  isTwoFactorChallenge: () => false, POST_AUTH_REDIRECT: "/app/track",
}));
vi.mock("@/lib/api-origin", () => ({
  subscribeApiOrigin: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
}));
vi.mock("@/components/server-picker", () => ({ NativeServerPicker: () => null }));
vi.mock("@/components/browser-sign-in", () => ({ BrowserSignIn: () => null }));
vi.mock("@/components/google-sign-in-button", () => ({ GoogleSignInButton: () => null }));
vi.mock("@/components/android-password-fill", () => ({
  AndroidPasswordFill: ({ onFill }: { onFill: (value: { email: string; password: string }) => void }) =>
    <button onClick={() => onFill({ email: "saved@example.com", password: "fake-password" })}>Pick password</button>,
}));
import LoginPage from "./page";
afterEach(() => { cleanup(); fake.signIn.mockClear(); });

it("populates both fields and waits for explicit login before sending credentials", async () => {
  render(<LoginPage />);
  fireEvent.click(screen.getByText("Pick password"));
  expect(screen.getByTestId("login-email")).toHaveValue("saved@example.com");
  expect(screen.getByTestId("login-password")).toHaveValue("fake-password");
  expect(fake.signIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("login-submit"));
  await waitFor(() => expect(fake.signIn).toHaveBeenCalledWith({ email: "saved@example.com", password: "fake-password" }));
});
it("clears a selected website credential when the server changes", () => {
  render(<LoginPage />);
  fireEvent.click(screen.getByText("Pick password"));
  act(() => fake.listeners.forEach((listener) => listener()));
  expect(screen.getByTestId("login-email")).toHaveValue("");
  expect(screen.getByTestId("login-password")).toHaveValue("");
  expect(fake.signIn).not.toHaveBeenCalled();
});
