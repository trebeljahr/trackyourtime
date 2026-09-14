import { describe, expect, it, vi } from "vitest";
import type { PermissionsApi } from "../lib/server-access";
import {
  planServerSwitch,
  switchServer,
  UNSENT_CHANGES_CODE,
  type SetServerOutcome,
} from "./switch-server";

const CLOUD = "https://api.trackyourtime.dev";

const fakePermissions = (granted = true): PermissionsApi => ({
  request: vi.fn(async () => granted),
  contains: vi.fn(async () => granted),
  remove: vi.fn(async () => true),
});

const accepting = (): ((origin: string) => Promise<SetServerOutcome>) =>
  vi.fn(async () => ({ ok: true }) as const);

const rejecting = (
  code = "SERVER_UNREACHABLE",
  message = "Could not reach track.example.com.",
): ((origin: string) => Promise<SetServerOutcome>) =>
  vi.fn(async () => ({ ok: false, code, message }) as const);

describe("switchServer", () => {
  it("requests access synchronously, before any microtask runs", () => {
    const permissions = fakePermissions();
    const send = accepting();

    const pending = switchServer({
      input: "track.example.com",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send,
    });

    // Nothing has been awaited yet: a user gesture would still be active here.
    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://track.example.com/*"],
    });
    expect(send).not.toHaveBeenCalled();
    return pending;
  });

  it("stops on an invalid address without asking Chrome", async () => {
    const permissions = fakePermissions();
    const send = accepting();
    const result = await switchServer({
      input: "http://track.example.com",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send,
    });
    expect(result).toMatchObject({ ok: false, stage: "input" });
    expect(permissions.request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refused access sends nothing to the worker and says why", async () => {
    const permissions = fakePermissions(false);
    const send = accepting();
    const result = await switchServer({
      input: "https://track.example.com",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send,
    });
    expect(result).toEqual({
      ok: false,
      stage: "access",
      code: "SERVER_ACCESS_REFUSED",
      message:
        "Chrome did not give the extension access to track.example.com, so it cannot reach that server.",
    });
    expect(send).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("releases a fresh grant when the worker rejects the server", async () => {
    const permissions = fakePermissions();
    const send = rejecting();
    const result = await switchServer({
      input: "https://track.example.com/track",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send,
    });
    expect(send).toHaveBeenCalledWith("https://track.example.com");
    expect(result).toMatchObject({
      ok: false,
      stage: "server",
      code: "SERVER_UNREACHABLE",
      message: "Could not reach track.example.com.",
    });
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://track.example.com/*"],
    });
  });

  it("keeps the grant when the worker accepts", async () => {
    const permissions = fakePermissions();
    const result = await switchServer({
      input: "https://track.example.com",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send: accepting(),
    });
    expect(result).toEqual({ ok: true, origin: "https://track.example.com" });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("never releases the server already in use when a re-check fails", async () => {
    const permissions = fakePermissions();
    await switchServer({
      input: "https://track.example.com",
      currentApiUrl: "https://track.example.com",
      defaultApiUrl: CLOUD,
      permissions,
      send: rejecting(),
    });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("does not release another port on the host in use — it is the same grant", async () => {
    const permissions = fakePermissions();
    await switchServer({
      input: "https://track.example.com:8443",
      currentApiUrl: "https://track.example.com",
      defaultApiUrl: CLOUD,
      permissions,
      send: rejecting(),
    });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("never releases the build's default server", async () => {
    const permissions = fakePermissions();
    await switchServer({
      input: CLOUD,
      currentApiUrl: "https://track.example.com",
      defaultApiUrl: CLOUD,
      permissions,
      send: rejecting(),
    });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("keeps the grant while the person is asked about unsent changes", async () => {
    const permissions = fakePermissions();
    const result = await switchServer({
      input: "https://track.example.com",
      currentApiUrl: CLOUD,
      defaultApiUrl: CLOUD,
      permissions,
      send: rejecting(UNSENT_CHANGES_CODE, "2 changes have not reached…"),
    });
    expect(result).toMatchObject({ ok: false, code: UNSENT_CHANGES_CODE });
    expect(permissions.remove).not.toHaveBeenCalled();
  });
});

describe("planServerSwitch", () => {
  it("asks first when queued changes would be discarded", () => {
    expect(planServerSwitch("track.example.com", CLOUD, 3)).toEqual({
      kind: "confirm",
      origin: "https://track.example.com",
      pending: 3,
    });
  });

  it("switches straight away with nothing queued, or to the same server", () => {
    expect(planServerSwitch("track.example.com", CLOUD, 0)).toEqual({
      kind: "switch",
      origin: "https://track.example.com",
    });
    expect(planServerSwitch(`${CLOUD}/`, CLOUD, 5)).toEqual({
      kind: "switch",
      origin: CLOUD,
    });
  });

  it("reports an unusable address", () => {
    expect(planServerSwitch("  ", CLOUD, 0)).toMatchObject({ kind: "invalid" });
  });
});
