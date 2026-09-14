import { describe, expect, it, vi } from "vitest";
import {
  hasServerAccess,
  originPermissionPattern,
  releaseServerAccess,
  requestServerAccess,
  sharesServerAccess,
  type PermissionsApi,
} from "./server-access";

const fakePermissions = (
  overrides: Partial<PermissionsApi> = {},
): PermissionsApi => ({
  request: vi.fn(async () => true),
  contains: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  ...overrides,
});

describe("originPermissionPattern", () => {
  it("drops the port, so one grant covers the host on every port", () => {
    expect(originPermissionPattern("https://track.example.com:8443")).toBe(
      "https://track.example.com/*",
    );
    expect(originPermissionPattern("http://localhost:5159")).toBe(
      "http://localhost/*",
    );
  });

  it("keeps the scheme and host of an https origin", () => {
    expect(originPermissionPattern("https://api.trackyourtime.dev")).toBe(
      "https://api.trackyourtime.dev/*",
    );
  });

  it("covers loopback over http", () => {
    expect(originPermissionPattern("http://127.0.0.1:51590")).toBe(
      "http://127.0.0.1/*",
    );
  });

  it("treats two ports on one host as one grant", () => {
    expect(
      sharesServerAccess("https://a.example", "https://a.example:8443"),
    ).toBe(true);
    expect(sharesServerAccess("https://a.example", "https://b.example")).toBe(
      false,
    );
  });
});

describe("requestServerAccess", () => {
  it("asks Chrome before returning, for exactly the one host", () => {
    const permissions = fakePermissions();
    void requestServerAccess("https://track.example.com", permissions);
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://track.example.com/*"],
    });
  });

  it("answers granted or refused", async () => {
    await expect(
      requestServerAccess("https://a.example", fakePermissions()),
    ).resolves.toBe("granted");
    await expect(
      requestServerAccess(
        "https://a.example",
        fakePermissions({ request: vi.fn(async () => false) }),
      ),
    ).resolves.toBe("refused");
  });

  it("reads a rejected or throwing request as refused", async () => {
    await expect(
      requestServerAccess(
        "https://a.example",
        fakePermissions({
          request: vi.fn(async () => {
            throw new Error("Only permissions specified in the manifest may be requested.");
          }),
        }),
      ),
    ).resolves.toBe("refused");
    await expect(
      requestServerAccess(
        "https://a.example",
        fakePermissions({
          request: vi.fn(() => {
            throw new Error("sync throw");
          }),
        }),
      ),
    ).resolves.toBe("refused");
  });
});

describe("hasServerAccess / releaseServerAccess", () => {
  it("reads a failing contains as no access", async () => {
    const permissions = fakePermissions({
      contains: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(hasServerAccess("https://a.example", permissions)).resolves.toBe(
      false,
    );
  });

  it("swallows a refused removal (a required host cannot be removed)", async () => {
    const permissions = fakePermissions({
      remove: vi.fn(async () => {
        throw new Error("You cannot remove required permissions.");
      }),
    });
    await expect(
      releaseServerAccess("https://api.trackyourtime.dev", permissions),
    ).resolves.toBeUndefined();
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://api.trackyourtime.dev/*"],
    });
  });
});
