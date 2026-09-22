// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthError } from "@starter/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Sign in with your browser": the desktop app's device flow.
 *
 * Driven against a fake `/api/auth/device/*`, because what matters here is
 * the client's half — which requests leave, what reaches the token store,
 * what a denial or a cancel leaves on screen. The server half is the same
 * better-auth plugin Raycast signs in through, and the Electron harness runs
 * both halves together (e2e/desktop).
 */

const shell = vi.hoisted(() => ({ value: "electron" as "web" | "electron" }));
vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => shell.value),
);

const setNativeToken = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/native-session", () => ({ setNativeToken }));

vi.mock("@/lib/api-origin", () => ({
  whenApiOriginReady: async () => undefined,
  getAbsoluteApiOrigin: () => "https://api.example.test",
}));

const { BrowserSignIn, browserSignInFailure } = await import("@/components/browser-sign-in");

type Answer = { status: number; body: Record<string, unknown> };

const requests: { url: string; init: RequestInit | undefined }[] = [];
let tokenAnswers: Answer[] = [];
const openExternal = vi.fn(async () => true);

const json = ({ status, body }: Answer): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  shell.value = "electron";
  requests.length = 0;
  tokenAnswers = [];
  setNativeToken.mockClear();
  openExternal.mockClear();
  Object.assign(window, { electronAPI: { isDesktop: true, platform: "darwin", openExternal } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/device/code")) {
      return json({
        status: 200,
        body: {
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://time.example.test/app/device",
          verification_uri_complete: "https://time.example.test/app/device?user_code=ABCD-EFGH",
          expires_in: 600,
          // The fastest the helper polls; the test waits it out.
          interval: 0,
        },
      });
    }
    const next = tokenAnswers.shift() ?? { status: 400, body: { error: "authorization_pending" } };
    return json(next);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "electronAPI");
});

describe("browserSignInFailure", () => {
  it("reads the RFC 8628 codes", () => {
    expect(browserSignInFailure(new AuthError("x", "access_denied"))).toBe("denied");
    expect(browserSignInFailure(new AuthError("x", "expired_token"))).toBe("expired");
    expect(browserSignInFailure(new AuthError("x", "EXPIRED_TOKEN"))).toBe("expired");
    expect(browserSignInFailure(new AuthError("x", "CANCELLED"))).toBe("cancelled");
    expect(browserSignInFailure(new TypeError("Failed to fetch"))).toBe("failed");
  });
});

describe("BrowserSignIn", () => {
  it("prerenders nothing, in the desktop app as on web", () => {
    expect(renderToString(<BrowserSignIn onSignedIn={async () => undefined} />)).toBe("");
  });

  it("renders nothing in a browser after hydration", () => {
    shell.value = "web";
    render(<BrowserSignIn onSignedIn={async () => undefined} />);
    expect(screen.queryByTestId("browser-sign-in")).toBeNull();
  });

  it("shows the code, opens the approval page and stores the approved token", async () => {
    tokenAnswers = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "approved-token", user: { id: "u1" } } },
    ];
    const onSignedIn = vi.fn(async () => undefined);
    render(<BrowserSignIn onSignedIn={onSignedIn} />);

    fireEvent.click(await screen.findByTestId("browser-sign-in"));
    expect(await screen.findByTestId("browser-sign-in-code")).toHaveTextContent("ABCD-EFGH");
    expect(openExternal).toHaveBeenCalledWith("https://time.example.test/app/device?user_code=ABCD-EFGH");

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(setNativeToken).toHaveBeenCalledWith("approved-token");

    // The desktop app's own client id, against the chosen server, no cookie.
    const code = requests[0];
    expect(code?.url).toBe("https://api.example.test/api/auth/device/code");
    expect(JSON.parse(String(code?.init?.body))).toEqual({ client_id: "trackyourtime-desktop" });
    for (const request of requests) expect(request.init?.credentials).toBe("omit");
  });

  it("returns to the button with a message when the browser declines", async () => {
    tokenAnswers = [{ status: 400, body: { error: "access_denied" } }];
    const onSignedIn = vi.fn(async () => undefined);
    render(<BrowserSignIn onSignedIn={onSignedIn} />);

    fireEvent.click(await screen.findByTestId("browser-sign-in"));
    expect(await screen.findByTestId("browser-sign-in-error", {}, { timeout: 5000 })).toHaveTextContent(
      "declined in the browser",
    );
    expect(screen.getByTestId("browser-sign-in")).toBeEnabled();
    expect(setNativeToken).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("names an untrusted origin instead of blaming the connection", async () => {
    // What Chromium does when the API omits Access-Control-Allow-Origin.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/health")) {
        return json({
          status: 200,
          body: { status: "ok", service: "trackyourtime", webUrl: "https://time.example.test", db: true, originTrusted: false },
        });
      }
      throw new TypeError("Failed to fetch");
    });
    render(<BrowserSignIn onSignedIn={async () => undefined} />);

    fireEvent.click(await screen.findByTestId("browser-sign-in"));
    const error = await screen.findByTestId("browser-sign-in-error");
    expect(error).toHaveTextContent("does not accept sign-ins from this app");
    expect(error).toHaveTextContent("TRUST_STORE_APPS=true");
  });

  it("keeps the connection message when the server trusts the app", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/health")) {
        return json({
          status: 200,
          body: { status: "ok", service: "trackyourtime", webUrl: "https://time.example.test", db: true, originTrusted: true },
        });
      }
      throw new TypeError("Failed to fetch");
    });
    render(<BrowserSignIn onSignedIn={async () => undefined} />);

    fireEvent.click(await screen.findByTestId("browser-sign-in"));
    expect(await screen.findByTestId("browser-sign-in-error")).toHaveTextContent("Check your connection");
  });

  it("stops polling on cancel and says nothing", async () => {
    render(<BrowserSignIn onSignedIn={async () => undefined} />);

    fireEvent.click(await screen.findByTestId("browser-sign-in"));
    fireEvent.click(await screen.findByTestId("browser-sign-in-cancel"));

    expect(await screen.findByTestId("browser-sign-in")).toBeEnabled();
    const polled = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(requests.length).toBe(polled);
    expect(screen.queryByTestId("browser-sign-in-error")).toBeNull();
    expect(setNativeToken).not.toHaveBeenCalled();
  });
});
