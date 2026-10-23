// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { DesktopWindowSnapshot } from "@starter/shared";
import { useDesktopWindow } from "./use-desktop-window";

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

it("ignores a stale initial snapshot after a native change, and unregisters on unmount", async () => {
  let changed: (snapshot: DesktopWindowSnapshot) => void = () => undefined;
  let resolve: (snapshot: DesktopWindowSnapshot) => void = () => undefined;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    electronAPI: {
      isDesktop: true,
      desktop: {
        window: {
          getState: () =>
            new Promise<DesktopWindowSnapshot>((done) => {
              resolve = done;
            }),
          onChanged: (callback: typeof changed) => {
            changed = callback;
            return unsubscribe;
          },
        },
      },
    },
  });
  const hook = renderHook(useDesktopWindow);
  await act(async () => changed({ mode: "compact", alwaysOnTop: true }));
  await act(async () => resolve({ mode: "full", alwaysOnTop: false }));
  expect(hook.result.current.compact).toBe(true);
  expect(hook.result.current.alwaysOnTop).toBe(true);
  hook.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("retains open editors in the full app and exposes failed IPC as a retryable error", async () => {
  let changed: (snapshot: DesktopWindowSnapshot) => void = () => undefined;
  const setMode = vi.fn(async () => ({
    mode: "full" as const,
    alwaysOnTop: false,
  }));
  Object.assign(window, {
    electronAPI: {
      isDesktop: true,
      desktop: {
        window: {
          getState: async () => ({ mode: "full", alwaysOnTop: false }),
          onChanged: (callback: typeof changed) => {
            changed = callback;
            return () => undefined;
          },
          setMode,
        },
      },
    },
  });
  const editor = document.createElement("div");
  editor.setAttribute("role", "dialog");
  editor.dataset.state = "open";
  document.body.append(editor);
  const hook = renderHook(useDesktopWindow);
  await act(async () => changed({ mode: "compact", alwaysOnTop: false }));
  expect(setMode).toHaveBeenCalledWith("full");
  expect(hook.result.current.compact).toBe(false);
  editor.remove();
  setMode.mockRejectedValueOnce(new Error("OS rejected the change"));
  await act(async () => {
    expect(await hook.result.current.setMode("compact")).toBe(false);
  });
  expect(hook.result.current.failed).toBe(true);
  expect(hook.result.current.compact).toBe(false);
});
