import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  platform: "android", available: true, origin: "https://api.trackyourtime.dev",
  getPassword: vi.fn(), cancel: vi.fn(async () => undefined),
  listeners: new Set<() => void>(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => fake.platform, isPluginAvailable: () => fake.available },
  registerPlugin: () => ({ getPassword: fake.getPassword, cancel: fake.cancel }),
}));
vi.mock("@/lib/api-origin", () => ({
  getAbsoluteApiOrigin: () => fake.origin,
  whenApiOriginReady: async () => undefined,
  subscribeApiOrigin: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
}));
import { canUseAndroidPasswords, getAndroidPassword } from "./android-password-manager";

beforeEach(() => {
  fake.platform = "android";
  fake.available = true;
  fake.origin = "https://api.trackyourtime.dev";
  fake.getPassword.mockReset().mockResolvedValue({ email: "test@example.com", password: "fake-password" });
  fake.cancel.mockClear();
  fake.listeners.clear();
});

describe("Android saved passwords", () => {
  it("returns the user-selected password using the hosted app identity", async () => {
    expect(await getAndroidPassword(new AbortController().signal)).toEqual({ email: "test@example.com", password: "fake-password" });
    expect(fake.getPassword).toHaveBeenCalledWith({ apiOrigin: "https://api.trackyourtime.dev" });
    expect(fake.listeners.size).toBe(0);
  });
  it.each(["web", "ios"])("does not call native credentials on %s", async (platform) => {
    fake.platform = platform;
    expect(await getAndroidPassword(new AbortController().signal)).toBeNull();
    expect(fake.getPassword).not.toHaveBeenCalled();
  });
  it("does not expose a button in older native builds without the plugin", () => {
    fake.available = false;
    expect(canUseAndroidPasswords()).toBe(false);
  });
  it.each(["https://self.example.com", "https://api.trackyourtime.dev.evil.test", "http://api.trackyourtime.dev"])("refuses website passwords for %s", async (origin) => {
    fake.origin = origin;
    expect(await getAndroidPassword(new AbortController().signal)).toBeNull();
    expect(fake.getPassword).not.toHaveBeenCalled();
  });
  it("treats user cancellation as no selection", async () => {
    fake.getPassword.mockRejectedValue({ code: "CANCELLED" });
    expect(await getAndroidPassword(new AbortController().signal)).toBeNull();
  });
  it("preserves no-credential errors for the UI", async () => {
    fake.getPassword.mockRejectedValue({ code: "NO_CREDENTIAL" });
    await expect(getAndroidPassword(new AbortController().signal)).rejects.toEqual({ code: "NO_CREDENTIAL" });
    expect(fake.listeners.size).toBe(0);
  });
  it.each(["abort", "server change"])("discards a late credential after %s", async (reason) => {
    let resolve!: (value: { email: string; password: string }) => void;
    fake.getPassword.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const result = getAndroidPassword(controller.signal);
    await vi.waitFor(() => expect(fake.getPassword).toHaveBeenCalled());
    if (reason === "abort") controller.abort();
    else fake.listeners.forEach((listener) => listener());
    // Still discard if the server changes away and back before the result arrives.
    resolve({ email: "test@example.com", password: "must-not-fill" });
    expect(await result).toBeNull();
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.listeners.size).toBe(0);
  });
});
