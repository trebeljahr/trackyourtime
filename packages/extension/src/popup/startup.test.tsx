import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { App } from "./App";

const opened = vi.hoisted(() => ({
  settings: undefined as (() => void) | undefined,
}));

vi.mock("./screens", () => ({
  Screens: ({
    tracker,
  }: {
    tracker: { state: BackgroundState; onOpenSettings: () => void };
  }) => {
    opened.settings = tracker.onOpenSettings;
    return <div>{tracker.state.running?.description}</div>;
  },
}));

describe("popup first render", () => {
  test.each([null, { userCode: "ABCDEFGH", expiresAt: Date.now() + 60_000 }])(
    "revalidates cached signed-out screens before displaying them (%j)",
    (pendingDeviceAuth) => {
      const html = renderToStaticMarkup(<App initialState={{
        signedIn: false, pendingDeviceAuth,
      } as BackgroundState} />);
      expect(html).toContain('data-testid="popup-loading"');
      expect(html).not.toContain("ABCDEFGH");
    },
  );
  test("settings opens the discovered web app's settings page", () => {
    const create = vi.spyOn(chrome.tabs, "create");
    renderToStaticMarkup(
      <App
        initialState={
          {
            signedIn: true,
            apiUrl: "https://api.example.test",
            webUrl: "https://app.example.test/",
            compatibility: {
              refusal: null,
              release: null,
              apiLevel: null,
              minServerApiLevel: 1,
            },
          } as BackgroundState
        }
      />,
    );
    opened.settings?.();
    expect(create).toHaveBeenCalledWith({
      url: "https://app.example.test/app/settings",
    });
  });

  test("shows the cached running timer before effects or a worker response", () => {
    const initialState = {
      signedIn: true,
      apiUrl: "https://api.example.test",
      compatibility: {
        refusal: null,
        release: null,
        apiLevel: null,
        minServerApiLevel: 1,
      },
      running: { description: "Cached running timer" },
    } as BackgroundState;
    const html = renderToStaticMarkup(<App initialState={initialState} />);
    expect(html).toContain("Cached running timer");
    expect(html).not.toContain('data-testid="popup-loading"');
  });

  test("keeps the loading fallback when no snapshot exists", () => {
    expect(renderToStaticMarkup(<App initialState={null} />)).toContain(
      'data-testid="popup-loading"',
    );
  });
});
