// @vitest-environment jsdom
/**
 * The Google button is rendered everywhere and decided after mount.
 *
 * What these pin: the first render is disabled whatever the host (that is
 * the prerendered HTML); a server without Google keeps it disabled; a native
 * shell keeps it disabled with a note and never asks the server; and only the
 * web app on a configured server can start the redirect.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";

let native = false;
let config: { googleEnabled: boolean; emailVerificationRequired: boolean } | undefined;
const useQuery = vi.fn((_input: unknown, options: { enabled: boolean }) => ({
  data: options.enabled && config ? { authConfig: config } : undefined,
}));
const social = vi.fn(async (_args: unknown) => ({ data: { url: "https://accounts.example" }, error: null }));

vi.mock("@/mobile/bridge", () => ({ isNative: () => native }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    health: {
      check: { useQuery: (input: unknown, options: { enabled: boolean }) => useQuery(input, options) },
    },
  },
}));
vi.mock("@/lib/auth-client", () => ({
  signIn: { social: (args: unknown) => social(args) },
  webCallbackUrl: (path: string) => `http://localhost:3392${path}`,
  POST_AUTH_REDIRECT: "/app/track",
}));

const { GoogleSignInButton, googleAvailability } = await import("./google-sign-in-button");

beforeEach(() => {
  native = false;
  config = { googleEnabled: true, emailVerificationRequired: false };
  useQuery.mockClear();
  social.mockClear();
});

afterEach(() => cleanup());

describe("googleAvailability", () => {
  it("is pending before mount, whatever else is known", () => {
    expect(googleAvailability({ mounted: false, shell: false, googleEnabled: true })).toBe("pending");
    expect(googleAvailability({ mounted: false, shell: true, googleEnabled: true })).toBe("pending");
  });

  it("puts the shell before the server's answer", () => {
    expect(googleAvailability({ mounted: true, shell: true, googleEnabled: true })).toBe("shell");
  });

  it("follows the server on the web", () => {
    expect(googleAvailability({ mounted: true, shell: false, googleEnabled: undefined })).toBe("pending");
    expect(googleAvailability({ mounted: true, shell: false, googleEnabled: false })).toBe("unconfigured");
    expect(googleAvailability({ mounted: true, shell: false, googleEnabled: true })).toBe("enabled");
  });
});

describe("GoogleSignInButton", () => {
  it("prerenders disabled", () => {
    const html = renderToString(<GoogleSignInButton />);
    expect(html).toMatch(/data-availability="pending"/);
    expect(html).toMatch(/disabled=""/);
  });

  it("is enabled on the web when the server has Google configured, and starts the redirect", async () => {
    render(<GoogleSignInButton />);
    const button = screen.getByTestId("google-sign-in-button");
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    await waitFor(() => expect(social).toHaveBeenCalled());
    expect(social.mock.calls[0]?.[0]).toMatchObject({
      provider: "google",
      callbackURL: "http://localhost:3392/app/track",
    });
  });

  it("stays disabled when the server reports Google is not configured", async () => {
    config = { googleEnabled: false, emailVerificationRequired: false };
    render(<GoogleSignInButton />);
    await waitFor(() =>
      expect(screen.getByTestId("google-sign-in")).toHaveAttribute("data-availability", "unconfigured"),
    );
    expect(screen.getByTestId("google-sign-in-button")).toBeDisabled();
  });

  it("stays disabled in a native shell, says why, and never asks the server", async () => {
    native = true;
    render(<GoogleSignInButton />);
    await waitFor(() =>
      expect(screen.getByTestId("google-sign-in")).toHaveAttribute("data-availability", "shell"),
    );
    expect(screen.getByTestId("google-sign-in-button")).toBeDisabled();
    expect(screen.getByTestId("google-sign-in-note")).toHaveTextContent(/web app only/);
    expect(useQuery.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
  });
});
