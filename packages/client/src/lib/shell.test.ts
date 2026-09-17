// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  clientId,
  entrySource,
  isCapacitor,
  isElectron,
  isTokenShell,
  shellTrustedOrigins,
} from "@/lib/shell";

/**
 * The three meanings the old `isNative()` conflated, read off the real
 * globals each shell injects. The desktop app must be a token shell without
 * being a phone: a phone answer there would put the tab bar, 16px fields and
 * Preferences storage on a desktop window.
 */

const host = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete host.Capacitor;
  delete host.electronAPI;
});

describe("lib/shell", () => {
  it("is the web app with no shell globals", () => {
    expect([isCapacitor(), isElectron(), isTokenShell()]).toEqual([false, false, false]);
    expect(clientId()).toBe("web");
    expect(entrySource()).toBe("web");
  });

  it("is the phone under Capacitor's native platform", () => {
    host.Capacitor = { isNativePlatform: () => true };
    expect([isCapacitor(), isElectron(), isTokenShell()]).toEqual([true, false, true]);
    expect(clientId()).toBe("trackyourtime-mobile");
    expect(entrySource()).toBe("mobile");
    expect(shellTrustedOrigins()).toBe("capacitor://localhost,https://localhost");
  });

  it("is not the phone when Capacitor's web runtime is loaded in a browser", () => {
    host.Capacitor = { isNativePlatform: () => false };
    expect(isCapacitor()).toBe(false);
    expect(isTokenShell()).toBe(false);
  });

  it("is the desktop app under the Electron bridge, and not the phone", () => {
    host.electronAPI = { isDesktop: true, platform: "darwin" };
    expect([isCapacitor(), isElectron(), isTokenShell()]).toEqual([false, true, true]);
    expect(clientId()).toBe("trackyourtime-desktop");
    expect(entrySource()).toBe("desktop");
    expect(shellTrustedOrigins()).toBe("app://-");
  });

  it("ignores an electronAPI that is not the desktop bridge", () => {
    host.electronAPI = { platform: "darwin" };
    expect(isElectron()).toBe(false);
  });
});
