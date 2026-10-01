// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("./sign-in-screen", () => ({ SignInScreen: () => <div>Ready to sign in</div> }));

test("a stalled startup offers Retry without overlapping polls and recovers", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const worker = vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(() => new Promise(() => {}));
  try {
    await act(async () => root.render(<App />));
    await act(async () => vi.advanceTimersByTimeAsync(14_000));
    expect(worker).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="popup-loading"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.querySelector('[data-testid="popup-retry"]')).not.toBeNull();
    worker.mockImplementation(() => Promise.resolve({ ok: true, state: {
      signedIn: false, apiUrl: "https://api.example.test",
      compatibility: { refusal: null, release: null, apiLevel: null, minServerApiLevel: 1 },
    } }));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Ready to sign in");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
