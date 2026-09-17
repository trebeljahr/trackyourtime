import { describe, expect, it, vi } from "vitest";
import {
  planServerSwitch,
  switchServer,
  UNSENT_CHANGES_CODE,
  type SetServerOutcome,
} from "./switch-server";

const CLOUD = "https://api.trackyourtime.dev";

const accepting = (): ((origin: string) => Promise<SetServerOutcome>) =>
  vi.fn(async () => ({ ok: true }) as const);

const rejecting = (
  code = "SERVER_UNREACHABLE",
  message = "Could not reach track.example.com.",
): ((origin: string) => Promise<SetServerOutcome>) =>
  vi.fn(async () => ({ ok: false, code, message }) as const);

describe("switchServer", () => {
  it("sends the normalized origin, not what was typed", async () => {
    const send = accepting();
    const result = await switchServer({ input: "track.example.com/track/", send });
    expect(send).toHaveBeenCalledWith("https://track.example.com");
    expect(result).toEqual({ ok: true, origin: "https://track.example.com" });
  });

  it("stops on an invalid address without asking the worker", async () => {
    const send = accepting();
    const result = await switchServer({ input: "http://track.example.com", send });
    expect(result).toMatchObject({ ok: false, stage: "input", problem: "insecure" });
    expect(send).not.toHaveBeenCalled();
  });

  it("asks nothing of Chrome — the extension holds no host access to request", async () => {
    const request = vi.spyOn(chrome.permissions, "request");
    await switchServer({ input: "https://track.example.com", send: accepting() });
    expect(request).not.toHaveBeenCalled();
  });

  it("passes the worker's refusal through with its code", async () => {
    const result = await switchServer({
      input: "https://track.example.com",
      send: rejecting("ORIGIN_NOT_TRUSTED", "track.example.com does not trust this extension."),
    });
    expect(result).toEqual({
      ok: false,
      stage: "server",
      code: "ORIGIN_NOT_TRUSTED",
      message: "track.example.com does not trust this extension.",
    });
  });

  it("reports unsent changes as a code the picker can ask about", async () => {
    const result = await switchServer({
      input: "https://track.example.com",
      send: rejecting(UNSENT_CHANGES_CODE, "2 changes have not reached…"),
    });
    expect(result).toMatchObject({ ok: false, code: UNSENT_CHANGES_CODE });
  });

  it("an unreachable server is the server stage", async () => {
    const result = await switchServer({ input: "https://track.example.com", send: rejecting() });
    expect(result).toMatchObject({ ok: false, stage: "server", code: "SERVER_UNREACHABLE" });
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
