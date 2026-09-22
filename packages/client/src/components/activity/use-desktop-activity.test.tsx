// @vitest-environment jsdom
/**
 * The nav's "is activity capture possible here": false on the web and until
 * main answers, and a snapshot push that does not change the answer does not
 * re-render the component reading it (the whole app shell, in practice).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DesktopActivitySnapshot } from "@starter/shared";

let shell: "web" | "electron" = "electron";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

const { useDesktopActivityAvailable } = await import("./use-desktop-activity");

let listener: ((snapshot: DesktopActivitySnapshot) => void) | null = null;
const snapshotOf = (supported: boolean, storedSegments = 0): DesktopActivitySnapshot =>
  ({ support: { supported }, storedSegments }) as unknown as DesktopActivitySnapshot;

let renders = 0;
function Probe(): React.JSX.Element {
  renders += 1;
  return <span data-testid="available">{String(useDesktopActivityAvailable())}</span>;
}

beforeEach(() => {
  shell = "electron";
  renders = 0;
  listener = null;
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    activity: {
      snapshot: async () => snapshotOf(true),
      onChanged: (next: (snapshot: DesktopActivitySnapshot) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useDesktopActivityAvailable", () => {
  it("answers once main does, and ignores pushes that change nothing it reports", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
    const settled = renders;
    act(() => {
      for (let i = 1; i <= 10; i += 1) listener?.(snapshotOf(true, i));
    });
    // React may render once more before it bails out on an equal state;
    // never once per push, which is what a snapshot in state would do.
    expect(renders - settled).toBeLessThanOrEqual(1);
    act(() => listener?.(snapshotOf(false)));
    expect(screen.getByTestId("available").textContent).toBe("false");
  });

  it("is false on the web, whatever the bridge says", async () => {
    shell = "web";
    render(<Probe />);
    await Promise.resolve();
    expect(screen.getByTestId("available").textContent).toBe("false");
    expect(listener).toBeNull();
  });
});
