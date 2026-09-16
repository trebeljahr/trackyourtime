// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerLevelCache, MIN_SERVER_API_LEVEL, type ServerLevelCache } from "@starter/core";

/**
 * The banner saying which side is too old. What these pin: it is never in
 * the prerendered HTML — whatever the cache holds, so hydration cannot
 * mismatch — and after mount it names the level, the minimum and the way out.
 */

vi.mock("@/mobile/bridge", () => ({ isNative: () => false }));

const { VersionBanner } = await import("@/components/version-banner");
const { __setServerLevelCacheForTests, getServerLevelCache, refreshServerLevel } = await import(
  "@/lib/server-level"
);
const { getAbsoluteApiOrigin, __resetApiOriginForTests } = await import("@/lib/api-origin");
const { SELF_HOSTING_UPGRADING_URL } = await import("@/lib/site-links");

let cache: ServerLevelCache;

beforeEach(() => {
  __resetApiOriginForTests();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
  cache = createServerLevelCache();
  __setServerLevelCacheForTests(cache);
});

afterEach(() => {
  cleanup();
  __setServerLevelCacheForTests(null);
  vi.unstubAllEnvs();
});

const record = (apiLevel: number, release: string | null = "0.0.9"): void =>
  cache.record({ origin: getAbsoluteApiOrigin(), apiLevel, minClientApiLevel: null, release });

describe("VersionBanner", () => {
  it("prerenders nothing, whatever the cache says", () => {
    const empty = renderToString(<VersionBanner />);
    record(0);
    const tooOld = renderToString(<VersionBanner />);
    cache.noteClientTooOld(getAbsoluteApiOrigin());
    const appTooOld = renderToString(<VersionBanner />);

    expect(empty).toBe("");
    expect(tooOld).toBe(empty);
    expect(appTooOld).toBe(empty);
  });

  it("hydrates prerendered HTML without a mismatch while the server is too old", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<VersionBanner />);
    document.body.appendChild(container);
    record(0);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hydrateRoot } = await import("react-dom/client");
    await act(async () => {
      hydrateRoot(container, <VersionBanner />);
    });
    expect(errors).not.toHaveBeenCalled();
    // …and the banner appears after mount.
    expect(container.querySelector('[data-testid="version-banner"]')).not.toBeNull();
    errors.mockRestore();
    container.remove();
  });

  it("renders nothing for a compatible or unknown server", () => {
    render(<VersionBanner />);
    expect(screen.queryByTestId("version-banner")).toBeNull();
    act(() => record(MIN_SERVER_API_LEVEL));
    expect(screen.queryByTestId("version-banner")).toBeNull();
  });

  it("names the server's release, level and the minimum, and links the upgrade guide", () => {
    render(<VersionBanner />);
    act(() => record(0, "0.0.9"));
    const banner = screen.getByTestId("version-banner");
    expect(banner).toHaveAttribute("data-refusal", "SERVER_TOO_OLD");
    expect(banner).toHaveTextContent(
      `This server runs v0.0.9 (API level 0). This app needs level ${MIN_SERVER_API_LEVEL} or higher. Ask your server admin to update.`,
    );
    const link = screen.getByTestId("version-banner-link");
    expect(link).toHaveAttribute("href", SELF_HOSTING_UPGRADING_URL);
    expect(link.tagName).toBe("A");
  });

  it("says the app is too old when the server refused this build", () => {
    render(<VersionBanner />);
    act(() => cache.noteClientTooOld(getAbsoluteApiOrigin()));
    const banner = screen.getByTestId("version-banner");
    expect(banner).toHaveAttribute("data-refusal", "CLIENT_TOO_OLD");
    expect(banner).toHaveTextContent("This app is too old for this server. Update the app.");
  });

  it("disappears once a refresh finds an updated server", async () => {
    const answers = [0, MIN_SERVER_API_LEVEL];
    __setServerLevelCacheForTests(
      createServerLevelCache({
        check: async (origin) => ({
          ok: true,
          server: {
            origin,
            release: "0.2.0",
            commit: null,
            webUrl: null,
            originTrusted: null,
            apiLevel: answers.shift() ?? MIN_SERVER_API_LEVEL,
            minClientApiLevel: 1,
          },
        }),
      }),
    );
    render(<VersionBanner />);
    await act(async () => {
      await refreshServerLevel();
    });
    expect(screen.getByTestId("version-banner")).toBeInTheDocument();
    await act(async () => {
      await refreshServerLevel();
    });
    expect(screen.queryByTestId("version-banner")).toBeNull();
    expect(getServerLevelCache().apiLevel(getAbsoluteApiOrigin())).toBe(MIN_SERVER_API_LEVEL);
  });
});
