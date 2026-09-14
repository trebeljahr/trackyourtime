/**
 * Unit tests for the sign-in helpers in @starter/core — what Raycast, the CLI
 * and the extensions use to get a session instead of being handed a
 * credential to paste. Everything here runs against a stub fetch; the failure
 * modes matter more than the happy path, because a client that thinks it
 * signed in but holds no token is worse than one that failed loudly.
 */
import { describe, expect, it } from "vitest";
import {
  AuthError,
  pollForDeviceSession,
  signInWithPassword,
  startDeviceAuthorization,
} from "@starter/core";

const OPTIONS = {
  baseUrl: "https://api.example.test",
  clientId: "trackyourtime-cli" as const,
};

type StubResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Replays a queued list of responses and records every request made. */
function stubFetch(queue: StubResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected extra request to ${String(input)}`);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => {};

describe("signInWithPassword", () => {
  it("returns the session token from the set-auth-token header", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: { user: { id: "user_1", email: "a@b.test" } },
        headers: { "set-auth-token": "session-token-1" },
      },
    ]);

    const session = await signInWithPassword(
      { ...OPTIONS, fetchImpl },
      { email: "a@b.test", password: "hunter2hunter2" }
    );

    expect(session.token).toBe("session-token-1");
    expect(session.userId).toBe("user_1");
    expect(calls[0].url).toBe("https://api.example.test/api/auth/sign-in/email");
    expect(
      (calls[0].init?.headers as Record<string, string>)["x-trackyourtime-client"]
    ).toBe("trackyourtime-cli");
  });

  it("fails loudly when the server returns no session token", async () => {
    // A cookie-only response is useless to a client with no cookie jar —
    // silently "succeeding" here would strand it unauthenticated.
    const { fetchImpl } = stubFetch([{ body: { user: { id: "user_1" } } }]);

    await expect(
      signInWithPassword(
        { ...OPTIONS, fetchImpl },
        { email: "a@b.test", password: "hunter2hunter2" }
      )
    ).rejects.toMatchObject({ code: "NO_SESSION_TOKEN" });
  });

  it("surfaces the server's own error for bad credentials", async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 401,
        body: { message: "Invalid email or password", code: "INVALID" },
      },
    ]);

    await expect(
      signInWithPassword(
        { ...OPTIONS, fetchImpl },
        { email: "a@b.test", password: "wrong" }
      )
    ).rejects.toThrow(AuthError);
  });
});

describe("startDeviceAuthorization", () => {
  it("returns the code pair the user needs to see", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          device_code: "dev_1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.example.test/device",
          verification_uri_complete:
            "https://app.example.test/device?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        },
      },
    ]);

    const auth = await startDeviceAuthorization({ ...OPTIONS, fetchImpl });

    expect(auth.userCode).toBe("ABCD-1234");
    expect(auth.deviceCode).toBe("dev_1");
    expect(auth.intervalSeconds).toBe(5);
    expect(JSON.parse(String(calls[0].init?.body)).client_id).toBe(
      "trackyourtime-cli"
    );
  });

  it("rejects a malformed response instead of returning a blank code", async () => {
    const { fetchImpl } = stubFetch([{ body: { expires_in: 600 } }]);

    await expect(
      startDeviceAuthorization({ ...OPTIONS, fetchImpl })
    ).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});

describe("pollForDeviceSession", () => {
  it("keeps waiting through authorization_pending, then returns the session", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        body: { user: { id: "user_1", email: "a@b.test" } },
        headers: { "set-auth-token": "session-token-2" },
      },
    ]);

    const session = await pollForDeviceSession(
      { ...OPTIONS, fetchImpl },
      "dev_1",
      { sleepImpl: noSleep }
    );

    expect(session.token).toBe("session-token-2");
    expect(calls).toHaveLength(3);
  });

  it("backs off on slow_down rather than giving up", async () => {
    const delays: number[] = [];
    const { fetchImpl } = stubFetch([
      { status: 400, body: { error: "slow_down" } },
      {
        body: { user: { id: "user_1" } },
        headers: { "set-auth-token": "session-token-3" },
      },
    ]);

    const session = await pollForDeviceSession(
      { ...OPTIONS, fetchImpl },
      "dev_1",
      {
        intervalSeconds: 5,
        sleepImpl: async (ms: number) => {
          delays.push(ms);
        },
      }
    );

    expect(session.token).toBe("session-token-3");
    expect(delays).toEqual([10_000]);
  });

  it("stops on a terminal error instead of polling forever", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 400,
        body: { error: "access_denied", error_description: "Declined" },
      },
    ]);

    await expect(
      pollForDeviceSession({ ...OPTIONS, fetchImpl }, "dev_1", {
        sleepImpl: noSleep,
      })
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(calls).toHaveLength(1);
  });

  it("honours an abort signal without making a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch([]);

    await expect(
      pollForDeviceSession({ ...OPTIONS, fetchImpl }, "dev_1", {
        signal: controller.signal,
        sleepImpl: noSleep,
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls).toHaveLength(0);
  });
});
