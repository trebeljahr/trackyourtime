import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { BackgroundState } from "../lib/messaging";
import { App } from "./App";

vi.mock("./screens", () => ({
  Screens: ({ tracker }: { tracker: { state: BackgroundState } }) => (
    <div>{tracker.state.running?.description}</div>
  ),
}));

describe("popup first render", () => {
  test("shows the cached running timer before effects or a worker response", () => {
    const initialState = {
      signedIn: true,
      apiUrl: "https://api.example.test",
      compatibility: { refusal: null, release: null, apiLevel: null, minServerApiLevel: 1 },
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
