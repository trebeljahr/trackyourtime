// @vitest-environment jsdom
/**
 * The forgotten-timer email is a reminder the person sets: the switch reads
 * off until they turn it on, a preferences row from before the option existed
 * reads off too, and a server too old to store it never shows the switch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ResolvedSettings } from "@starter/shared";

import { FALLBACK_SETTINGS } from "@/lib/format";
import type { WorkspaceSettingsController } from "./use-workspace-settings";
import { MaxDurationSettingsPanel } from "./max-duration-settings";

let serverHasEmailReminder = true;
vi.mock("@/lib/server-level", () => ({
  useServerSupports: (capability: string) =>
    capability === "settings.forgottenTimerEmail" ? serverHasEmailReminder : true,
}));

afterEach(() => {
  cleanup();
  serverHasEmailReminder = true;
});

function renderPanel(settings: ResolvedSettings = FALLBACK_SETTINGS) {
  const save = vi.fn();
  const controller: WorkspaceSettingsController = {
    settings,
    isLoaded: true,
    saveState: "idle",
    save,
  };
  render(<MaxDurationSettingsPanel controller={controller} />);
  return { save };
}

describe("MaxDurationSettingsPanel: forgotten-timer email", () => {
  it("is off by default, and turning it on saves only that field", () => {
    const { save } = renderPanel();
    const toggle = screen.getByTestId("max-duration-email-reminder");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Email me about a forgotten timer")).toBeTruthy();

    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith({ maxDuration: { emailReminder: true } });
  });

  it("reads off for settings stored before the option existed", () => {
    renderPanel({ ...FALLBACK_SETTINGS, maxDuration: { maxHours: 12, behavior: "ask" } });
    expect(screen.getByTestId("max-duration-email-reminder").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("shows on once turned on, and turning it off saves false", () => {
    const { save } = renderPanel({
      ...FALLBACK_SETTINGS,
      maxDuration: { ...FALLBACK_SETTINGS.maxDuration, emailReminder: true },
    });
    const toggle = screen.getByTestId("max-duration-email-reminder");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith({ maxDuration: { emailReminder: false } });
  });

  it("stays usable with the guard off, where it is the only 8-hour check", () => {
    renderPanel({ ...FALLBACK_SETTINGS, maxDuration: { maxHours: 0, behavior: "ask" } });
    expect(screen.getByTestId("max-duration-email-reminder").hasAttribute("disabled")).toBe(false);
  });

  it("is not offered by a server too old to store it", () => {
    serverHasEmailReminder = false;
    renderPanel();
    expect(screen.queryByTestId("max-duration-email-reminder")).toBeNull();
  });
});
