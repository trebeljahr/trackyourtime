// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DonateLink, DonationReturn } from "@/components/marketing/donate-link";
import { DONATION_SUPPORTED_AT_KEY } from "@/lib/donation-return";
import type { MockShell } from "@/lib/shell-mock";

const shell = vi.hoisted(() => ({ value: "web" as MockShell }));
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell.value));

const list = (): React.ReactElement => (
  <ul>
    <DonateLink label="Donate" />
  </ul>
);

describe("DonateLink", () => {
  afterEach(cleanup);

  beforeEach(() => {
    shell.value = "web";
  });

  it("links the shared donate page, in the same tab", () => {
    render(list());
    const link = screen.getByTestId("marketing-donate");
    expect(link.getAttribute("href")).toBe("https://ricos.site/donate?from=track-your-time");
    expect(link.textContent).toBe("Donate");
    expect(link.hasAttribute("target")).toBe(false);
  });

  it("stays on the desktop app, where no store rule forbids it", () => {
    shell.value = "electron";
    render(list());
    expect(screen.queryByTestId("marketing-donate")).not.toBeNull();
  });

  it("is gone in the iOS and Android app, after a hydration that matches the served HTML", async () => {
    const served = renderToString(list());
    expect(served).toContain("ricos.site/donate");

    shell.value = "capacitor";
    const container = document.createElement("div");
    container.innerHTML = served;
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, list(), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="marketing-donate"]')).toBeNull();
    errors.mockRestore();
    container.remove();
  });
});

describe("DonationReturn", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("records a ?supported=1 arrival on mount and cleans the address", () => {
    window.history.replaceState(null, "", "/?supported=1&ref=a#top");
    render(<DonationReturn />);
    expect(window.localStorage.getItem(DONATION_SUPPORTED_AT_KEY)).toMatch(/^\d+$/);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/?ref=a#top");
  });
});
