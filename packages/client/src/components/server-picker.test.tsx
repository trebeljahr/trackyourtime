// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/**
 * The login screen's server picker exists for the phone apps only.
 *
 * What these pin is the promise the web app depends on: a browser gets the
 * login page it always got — nothing extra in the served HTML, nothing extra
 * after hydration — and on a phone the choice is validated before a single
 * thing about the device changes.
 */

const native = { value: false };
const checkServer = vi.fn();
const switchServer = vi.fn(async () => "switched" as const);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/mobile/bridge", () => ({ isNative: () => native.value }));

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

// Preferences, as the memory store it is to a test. The real plugin is what
// the Simulator loop in CLAUDE.md exercises.
vi.mock("@/mobile/preferences-storage", () => {
  const values = new Map<string, string>();
  const shared = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  return { preferencesStorage: () => shared };
});

vi.mock("@/lib/offline", () => ({
  refreshPendingCount: async () => 0,
}));

vi.mock("@/lib/server-switch", () => ({
  switchServer: (...args: unknown[]) => switchServer(...(args as [])),
}));

vi.mock("@starter/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@starter/core")>()),
  checkServer: (...args: unknown[]) => checkServer(...args),
}));

const { default: LoginPage } = await import("@/app/login/page");
const { __resetApiOriginForTests } = await import("@/lib/api-origin");

const OWN = "https://track.example.com";

const found = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  server: {
    origin: OWN,
    release: "0.1.0",
    commit: null,
    webUrl: OWN,
    originTrusted: true,
    ...overrides,
  },
});

beforeEach(() => {
  native.value = false;
  checkServer.mockReset();
  switchServer.mockClear();
  __resetApiOriginForTests();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.trackyourtime.dev");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("the login page on web", () => {
  it("prerenders the same HTML whether or not the host is native", () => {
    // The static export prerenders in Node, where no host is native; the
    // server snapshot is what hydration compares against on BOTH platforms.
    native.value = false;
    const web = renderToString(<LoginPage />);
    native.value = true;
    const phone = renderToString(<LoginPage />);

    expect(phone).toBe(web);
    expect(web).not.toContain("server-picker");
  });

  it("never shows a server choice in a browser, even after hydration", async () => {
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId("login-submit")).toBeTruthy());
    expect(screen.queryByTestId("server-picker")).toBeNull();
  });
});

describe("the login page on a phone", () => {
  const openPicker = async (): Promise<void> => {
    native.value = true;
    render(<LoginPage />);
    // Re-queried: the picker remounts once the stored choice has been read.
    await waitFor(() =>
      expect(screen.getByTestId("server-picker-toggle")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("server-picker-toggle"));
  };

  it("names the build's default server as the cloud", async () => {
    await openPicker();
    expect(screen.getByTestId("server-picker-current")).toHaveTextContent(
      "Track Your Time cloud",
    );
    expect(screen.getByTestId("server-picker")).toHaveTextContent(
      "Track Your Time cloud",
    );
  });

  it("refuses plain http off this device before asking the network anything", async () => {
    await openPicker();
    fireEvent.click(screen.getByTestId("server-picker-own"));
    fireEvent.change(screen.getByTestId("server-picker-address"), {
      target: { value: "http://track.example.com" },
    });
    fireEvent.click(screen.getByTestId("server-picker-save"));

    expect(await screen.findByTestId("server-picker-error")).toHaveTextContent(
      "Use https:// for track.example.com",
    );
    expect(checkServer).not.toHaveBeenCalled();
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("says plainly when the address is not a Track Your Time server", async () => {
    checkServer.mockResolvedValue({
      ok: false,
      problem: "not-trackyourtime",
      message: "track.example.com answered, but it is not a Track Your Time server.",
    });
    await openPicker();
    fireEvent.click(screen.getByTestId("server-picker-own"));
    fireEvent.change(screen.getByTestId("server-picker-address"), {
      target: { value: "track.example.com" },
    });
    fireEvent.click(screen.getByTestId("server-picker-save"));

    expect(await screen.findByTestId("server-picker-error")).toHaveTextContent(
      "not a Track Your Time server",
    );
    // No scheme typed; https assumed.
    expect(checkServer).toHaveBeenCalledWith(OWN);
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("refuses a server that does not trust the app, and says what to change", async () => {
    checkServer.mockResolvedValue(found({ originTrusted: false }));
    await openPicker();
    fireEvent.click(screen.getByTestId("server-picker-own"));
    fireEvent.change(screen.getByTestId("server-picker-address"), {
      target: { value: OWN },
    });
    fireEvent.click(screen.getByTestId("server-picker-save"));

    expect(await screen.findByTestId("server-picker-error")).toHaveTextContent(
      "TRUST_STORE_APPS=true",
    );
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("switches to a validated server and shows the version it found", async () => {
    checkServer.mockResolvedValue(found());
    await openPicker();
    fireEvent.click(screen.getByTestId("server-picker-own"));
    fireEvent.change(screen.getByTestId("server-picker-address"), {
      target: { value: `${OWN}/track/` },
    });
    fireEvent.click(screen.getByTestId("server-picker-save"));

    await waitFor(() =>
      expect(switchServer).toHaveBeenCalledWith({
        origin: OWN,
        webUrl: OWN,
        release: "0.1.0",
      }),
    );
    expect(screen.getByTestId("server-picker-found")).toHaveTextContent(
      "Found Track Your Time 0.1.0 at track.example.com",
    );
  });

  it("goes back to the cloud with a null choice", async () => {
    checkServer.mockResolvedValue(
      found({ origin: "https://api.trackyourtime.dev", webUrl: "https://trackyourtime.dev" }),
    );
    await openPicker();
    fireEvent.click(screen.getByTestId("server-picker-save"));
    await waitFor(() => expect(switchServer).toHaveBeenCalledWith(null));
  });
});
