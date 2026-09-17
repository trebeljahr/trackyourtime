/**
 * The device flow's single exchange, and the poll loop built on it.
 *
 * `requestDeviceToken` is what a client whose process can stop between two
 * polls (the extension's service worker) calls from whatever wakes it, so
 * each RFC 8628 answer must come back as a value or a named error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuthError, pollForDeviceSession, requestDeviceToken } from "../session-auth.js";

const options = (fetchImpl: typeof fetch) => ({
  baseUrl: "http://localhost:5159",
  clientId: "trackyourtime-extension" as const,
  fetchImpl,
});

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sequence = (responses: Response[]): { fetchImpl: typeof fetch; calls: () => number } => {
  let index = 0;
  const fetchImpl = (async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls: () => index };
};

describe("requestDeviceToken", () => {
  it("answers pending for authorization_pending", async () => {
    const { fetchImpl } = sequence([answer(400, { error: "authorization_pending" })]);
    assert.deepEqual(await requestDeviceToken(options(fetchImpl), "dc"), { status: "pending" });
  });

  it("answers slow-down for slow_down", async () => {
    const { fetchImpl } = sequence([answer(400, { error: "slow_down" })]);
    assert.deepEqual(await requestDeviceToken(options(fetchImpl), "dc"), { status: "slow-down" });
  });

  it("returns the access_token as the session token", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return answer(200, { access_token: "tok", token_type: "Bearer", expires_in: 1 });
    }) as typeof fetch;
    const result = await requestDeviceToken(options(fetchImpl), "dc");
    assert.deepEqual(result, {
      status: "approved",
      session: { token: "tok", userId: null, email: null },
    });
    assert.deepEqual(sent, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc",
      client_id: "trackyourtime-extension",
    });
  });

  it("throws access_denied", async () => {
    const { fetchImpl } = sequence([answer(400, { error: "access_denied" })]);
    await assert.rejects(
      requestDeviceToken(options(fetchImpl), "dc"),
      (error: unknown) => error instanceof AuthError && error.code === "access_denied",
    );
  });

  it("throws expired_token", async () => {
    const { fetchImpl } = sequence([answer(400, { error: "expired_token" })]);
    await assert.rejects(
      requestDeviceToken(options(fetchImpl), "dc"),
      (error: unknown) => error instanceof AuthError && error.code === "expired_token",
    );
  });

  it("throws NO_SESSION_TOKEN for a success without a token", async () => {
    const { fetchImpl } = sequence([answer(200, {})]);
    await assert.rejects(
      requestDeviceToken(options(fetchImpl), "dc"),
      (error: unknown) => error instanceof AuthError && error.code === "NO_SESSION_TOKEN",
    );
  });
});

describe("pollForDeviceSession", () => {
  it("waits through pending and slow_down, backing off, then returns the session", async () => {
    const { fetchImpl, calls } = sequence([
      answer(400, { error: "authorization_pending" }),
      answer(400, { error: "slow_down" }),
      answer(200, { access_token: "tok" }),
    ]);
    const sleeps: number[] = [];
    const session = await pollForDeviceSession(options(fetchImpl), "dc", {
      intervalSeconds: 2,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(session.token, "tok");
    assert.equal(calls(), 3);
    assert.deepEqual(sleeps, [2000, 7000]);
  });

  it("stops on a terminal error", async () => {
    const { fetchImpl } = sequence([answer(400, { error: "access_denied" })]);
    await assert.rejects(
      pollForDeviceSession(options(fetchImpl), "dc", { sleepImpl: async () => {} }),
      (error: unknown) => error instanceof AuthError && error.code === "access_denied",
    );
  });
});
