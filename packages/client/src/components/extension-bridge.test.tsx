// @vitest-environment jsdom
/**
 * The bridge component renders nothing, runs nothing before mount, and stays
 * inert in the native and desktop shells. The decisions themselves are
 * `lib/extension-bridge.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { EXTENSION_BRIDGE_CHANNEL, STORE_EXTENSION_ID } from "@starter/shared";

type SessionResult = {
  data: { user: { id: string }; session: { createdAt: Date | string } } | null;
  isPending: boolean;
  error: unknown;
};

let appShell = false;
let session: SessionResult = { data: null, isPending: true, error: null };

vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => (appShell ? "electron" : "web")),
);
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://api.trackyourtime.dev" }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => session,
  signOut: vi.fn(async () => undefined),
}));
vi.mock("@/lib/device-approve", () => ({
  approveDeviceCode: vi.fn(async () => ({ ok: true })),
}));

const { ExtensionBridge, bridgeSessionState, isTopLevelDocument } = await import("./extension-bridge");

const sendMessage = vi.fn(
  (_id: string, _message: unknown, callback: (response: unknown) => void) => callback(undefined),
);

const setChrome = (value: unknown): void => {
  (globalThis as { chrome?: unknown }).chrome = value;
};

beforeEach(() => {
  appShell = false;
  session = { data: null, isPending: true, error: null };
  sendMessage.mockClear();
  setChrome({ runtime: { sendMessage } });
});

afterEach(() => {
  cleanup();
  delete (globalThis as { chrome?: unknown }).chrome;
});

const signedIn = (): SessionResult => ({
  data: { user: { id: "user-u" }, session: { createdAt: "2026-09-17T10:00:00.000Z" } },
  isPending: false,
  error: null,
});

describe("ExtensionBridge", () => {
  it("renders nothing, on the server and in the browser", () => {
    expect(renderToString(<ExtensionBridge />)).toBe("");
    const { container } = render(<ExtensionBridge />);
    expect(container.innerHTML).toBe("");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends nothing while the session is pending or failed", async () => {
    const view = render(<ExtensionBridge />);
    session = { data: null, isPending: false, error: new Error("offline") };
    view.rerender(<ExtensionBridge />);
    await act(async () => undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("describes a resolved session to the store extension", async () => {
    session = signedIn();
    render(<ExtensionBridge />);
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [id, message] = sendMessage.mock.calls[0]!;
    expect(id).toBe(STORE_EXTENSION_ID);
    expect(message).toEqual({
      channel: EXTENSION_BRIDGE_CHANNEL,
      v: 1,
      kind: "sync",
      apiOrigin: "https://api.trackyourtime.dev",
      web: { userId: "user-u", sessionCreatedAt: Date.parse("2026-09-17T10:00:00.000Z") },
    });
  });

  it("sends a sign-out at once", async () => {
    session = signedIn();
    const view = render(<ExtensionBridge />);
    await act(async () => undefined);
    session = { data: null, isPending: false, error: null };
    view.rerender(<ExtensionBridge />);
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((sendMessage.mock.calls[1]![1] as { web: unknown }).web).toEqual({
      userId: null,
      sessionCreatedAt: null,
    });
  });

  it("never runs in an app shell", async () => {
    appShell = true;
    session = signedIn();
    render(<ExtensionBridge />);
    await act(async () => undefined);
    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never runs inside a frame", async () => {
    const top = vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    try {
      session = signedIn();
      render(<ExtensionBridge />);
      await act(async () => undefined);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      top.mockRestore();
    }
  });

  it("never runs without chrome.runtime", async () => {
    setChrome(undefined);
    session = signedIn();
    render(<ExtensionBridge />);
    await act(async () => undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("isTopLevelDocument", () => {
  it("is true for a tab's own document and false for a frame", () => {
    expect(isTopLevelDocument(window)).toBe(true);
    const framed = { self: {}, top: {} } as unknown as Window;
    expect(isTopLevelDocument(framed)).toBe(false);
    const crossOrigin = {
      self: {},
      get top(): Window {
        throw new Error("SecurityError");
      },
    } as unknown as Window;
    expect(isTopLevelDocument(crossOrigin)).toBe(false);
  });
});

describe("bridgeSessionState", () => {
  it("maps pending, error and resolved", () => {
    expect(bridgeSessionState({ data: null, isPending: true, error: null })).toEqual({ status: "pending" });
    expect(bridgeSessionState({ data: null, isPending: false, error: { status: 0 } })).toEqual({
      status: "error",
    });
    expect(bridgeSessionState({ data: null, isPending: false, error: null })).toEqual({
      status: "resolved",
      session: null,
    });
    expect(bridgeSessionState(signedIn())).toEqual({
      status: "resolved",
      session: { userId: "user-u", createdAt: Date.parse("2026-09-17T10:00:00.000Z") },
    });
  });

  it("refuses a session whose start cannot be read", () => {
    expect(
      bridgeSessionState({
        data: { user: { id: "user-u" }, session: { createdAt: "not a date" } },
        isPending: false,
        error: null,
      }),
    ).toEqual({ status: "error" });
  });
});
