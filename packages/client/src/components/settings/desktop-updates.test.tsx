// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { DesktopUpdateDisabledReason, DesktopUpdateSnapshot } from "@starter/shared";

import { DesktopUpdatesCard } from "./desktop-updates";

function installBridge(initial: DesktopUpdateSnapshot | null) {
  const calls = { checks: 0, restarts: 0 };
  let push: ((snapshot: DesktopUpdateSnapshot) => void) | null = null;
  let current = initial;
  (window as { electronAPI?: unknown }).electronAPI = {
    isDesktop: true,
    platform: "darwin",
    desktop:
      initial === null
        ? {}
        : {
            updates: {
              getStatus: () => Promise.resolve(current),
              onStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => {
                push = listener;
                return () => {
                  push = null;
                };
              },
              check: () => {
                calls.checks += 1;
                current = { ...current!, status: { kind: "checking", lastCheckedAt: null } };
                return Promise.resolve(current);
              },
              restart: () => {
                calls.restarts += 1;
                return Promise.resolve(current?.status.kind === "ready");
              },
            },
          },
  };
  return {
    calls,
    push: (snapshot: DesktopUpdateSnapshot) =>
      act(() => {
        current = snapshot;
        push?.(snapshot);
      }),
  };
}

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("DesktopUpdatesCard", () => {
  it("renders nothing on the web, or with a preload that has no updater", async () => {
    expect(renderToString(<DesktopUpdatesCard />)).toBe("");
    const { container } = render(<DesktopUpdatesCard />);
    await act(async () => undefined);
    expect(container.innerHTML).toBe("");
    cleanup();
    installBridge(null);
    const second = render(<DesktopUpdatesCard />);
    await act(async () => undefined);
    expect(second.container.innerHTML).toBe("");
  });

  it("shows the version and checks on request", async () => {
    const bridge = installBridge({ currentVersion: "0.1.0", status: { kind: "idle", lastCheckedAt: null } });
    render(<DesktopUpdatesCard />);
    expect((await screen.findByTestId("desktop-update-version")).textContent).toBe("Version 0.1.0");
    expect(screen.getByTestId("desktop-update-status").textContent).toContain("every 6 hours");
    await act(async () => {
      fireEvent.click(screen.getByTestId("desktop-update-check"));
    });
    expect(bridge.calls.checks).toBe(1);
    expect(screen.getByTestId("desktop-update-status").textContent).toBe("Checking for updates…");
    expect((screen.getByTestId("desktop-update-check") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Restart to update when an update is ready, and restarts only on the click", async () => {
    const bridge = installBridge({ currentVersion: "0.1.0", status: { kind: "downloading", version: "0.1.1", percent: 40 } });
    render(<DesktopUpdatesCard />);
    expect((await screen.findByTestId("desktop-update-status")).textContent).toBe("Downloading version 0.1.1 (40%)…");
    bridge.push({ currentVersion: "0.1.0", status: { kind: "ready", version: "0.1.1" } });
    expect(screen.getByTestId("desktop-update-status").textContent).toContain("Version 0.1.1 is ready");
    expect(bridge.calls.restarts).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("desktop-update-restart"));
    });
    expect(bridge.calls.restarts).toBe(1);
  });

  it("explains every reason a copy does not update itself, with no button", async () => {
    const reasons: DesktopUpdateDisabledReason[] = ["store", "sandbox", "package-manager", "no-feed", "unpackaged", "turned-off"];
    for (const reason of reasons) {
      installBridge({ currentVersion: "0.1.0", status: { kind: "disabled", reason } });
      render(<DesktopUpdatesCard />);
      const status = await screen.findByTestId("desktop-update-status");
      expect(status.textContent).not.toMatch(/desktop\.updates/);
      expect(status.textContent?.length).toBeGreaterThan(10);
      expect(screen.queryByTestId("desktop-update-check")).toBeNull();
      expect(screen.queryByTestId("desktop-update-restart")).toBeNull();
      cleanup();
    }
  });
});
