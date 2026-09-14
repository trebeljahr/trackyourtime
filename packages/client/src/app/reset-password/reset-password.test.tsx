// @vitest-environment jsdom
/**
 * A refused reset must stay on the reset screen and say why.
 *
 * better-auth's client resolves a refusal as `{ data: null, error }` instead
 * of throwing. The page used to handle only a throw, so an expired link
 * "succeeded" onto /login with the old password still in force and no word
 * about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  commitTargetLocale,
  resetLocaleStoreForTests,
  setLocalePreference,
} from "@/i18n/locale-store";

const push = vi.fn();
let search = "token=abc";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(search),
}));

const resetPassword = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { resetPassword: (...args: unknown[]) => resetPassword(...args) },
}));

const { default: ResetPasswordPage } = await import("./page");

const setNavigatorLanguages = (languages: string[]): void => {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
};

const submit = (password = "correct horse battery"): void => {
  fireEvent.change(screen.getByTestId("reset-new-password"), { target: { value: password } });
  fireEvent.change(screen.getByTestId("reset-confirm-password"), { target: { value: password } });
  fireEvent.click(screen.getByTestId("reset-submit"));
};

beforeEach(() => {
  window.localStorage.clear();
  setNavigatorLanguages(["en-US"]);
  resetLocaleStoreForTests();
  act(() => commitTargetLocale());
  search = "token=abc";
  push.mockReset();
  resetPassword.mockReset();
});

afterEach(() => {
  cleanup();
  resetLocaleStoreForTests();
});

describe("reset password", () => {
  it("goes to /login when the reset succeeds", async () => {
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });
    render(<ResetPasswordPage />);
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(resetPassword).toHaveBeenCalledWith({
      newPassword: "correct horse battery",
      token: "abc",
    });
    expect(screen.queryByTestId("reset-error")).toBeNull();
  });

  it("stays put and names an expired link when the result carries INVALID_TOKEN", async () => {
    resetPassword.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TOKEN", status: 400, message: "Invalid token" },
    });
    render(<ResetPasswordPage />);
    submit();
    const alert = await screen.findByTestId("reset-error");
    expect(alert.textContent).toContain("This reset link has expired or was already used.");
    expect(screen.getByTestId("reset-request-new").getAttribute("href")).toBe("/forgot-password");
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the generic failure for a refusal it has no words for, never the library's text", async () => {
    resetPassword.mockResolvedValue({
      data: null,
      error: { code: "SOMETHING_NEW", status: 500, message: "Library English" },
    });
    render(<ResetPasswordPage />);
    submit();
    const alert = await screen.findByTestId("reset-error");
    expect(alert.textContent).toBe("Failed to reset password. The link may have expired.");
    expect(screen.queryByTestId("reset-request-new")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the generic failure when the request never gets an answer", async () => {
    resetPassword.mockRejectedValue(new TypeError("fetch failed"));
    render(<ResetPasswordPage />);
    submit();
    const alert = await screen.findByTestId("reset-error");
    expect(alert.textContent).toBe("Failed to reset password. The link may have expired.");
    expect(push).not.toHaveBeenCalled();
  });

  it("says the link expired on arrival when better-auth redirected with ?error=INVALID_TOKEN", () => {
    search = "error=INVALID_TOKEN";
    render(<ResetPasswordPage />);
    expect(screen.getByTestId("reset-error").textContent).toContain(
      "This reset link has expired or was already used.",
    );
    expect(screen.getByTestId("reset-request-new")).toBeTruthy();
  });

  it("says it in German", async () => {
    act(() => setLocalePreference("de"));
    resetPassword.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TOKEN", status: 400 },
    });
    render(<ResetPasswordPage />);
    submit();
    const alert = await screen.findByTestId("reset-error");
    expect(alert.textContent).toContain(
      "Dieser Link zum Zurücksetzen ist abgelaufen oder wurde schon benutzt. Fordere einen neuen an.",
    );
    expect(screen.getByTestId("reset-request-new").textContent).toBe("Neuen Link anfordern");
  });
});
