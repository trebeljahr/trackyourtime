// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { MobileTabBar } from "./mobile-tab-bar";

/*
 * The bar itself. What it must NOT do is decide whether to exist: it renders
 * on every platform and `styles/native.css` reveals it under `html.cap`. The
 * proof that this leaves the web app alone is the phone-viewport Playwright
 * project, which measures the computed `display` in a real browser — jsdom
 * loads no stylesheet and could not tell the difference.
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const renderBar = (pathname: string, moreOpen = false): void => {
  render(
    <MobileTabBar
      pathname={pathname}
      onOpenMore={() => undefined}
      moreOpen={moreOpen}
    />,
  );
};

const activeTab = (): string | undefined =>
  ["track", "reports", "more"].find(
    (key) => screen.getByTestId(`tab-${key}`).dataset.active === "true",
  );

describe("MobileTabBar", () => {
  it("renders on web too, hidden by a display:none utility", () => {
    // The alternative — returning null unless `isNative()` — is a hydration
    // mismatch under `output: "export"`: the prerender runs in Node, where
    // `window.Capacitor` cannot exist, so the served HTML would always have
    // the bar and the native hydration would always drop it.
    renderBar("/track");
    expect(screen.getByTestId("mobile-tab-bar").className).toContain("hidden");
  });

  it("lights Track on /track", () => {
    renderBar("/track");
    expect(activeTab()).toBe("track");
  });

  it("keeps Reports lit under /reports", () => {
    // The retired report routes are redirects under /reports, so a bookmark
    // to one must not light More for the frame before it lands.
    renderBar("/reports/summary");
    expect(activeTab()).toBe("reports");
  });

  it("falls back to More on a screen no tab owns", () => {
    // Otherwise a phone sitting on /settings shows no active tab at all,
    // which reads as a broken bar rather than as a deliberate one.
    renderBar("/settings");
    expect(activeTab()).toBe("more");
  });

  it("lights More while the drawer is open, over the current route", () => {
    renderBar("/track", true);
    expect(activeTab()).toBe("more");
  });

  it("points Reports at the one Reports page", () => {
    renderBar("/track");
    expect(screen.getByTestId("tab-reports").getAttribute("href")).toBe(
      "/reports",
    );
  });

  it("opens the drawer rather than navigating", () => {
    const onOpenMore = vi.fn();
    render(
      <MobileTabBar pathname="/track" onOpenMore={onOpenMore} moreOpen={false} />,
    );

    const more = screen.getByTestId("tab-more");
    expect(more.tagName).toBe("BUTTON");
    more.click();
    expect(onOpenMore).toHaveBeenCalledTimes(1);
  });
});
