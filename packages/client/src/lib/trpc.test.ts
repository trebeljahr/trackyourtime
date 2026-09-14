import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web request path, asserted rather than assumed.
 *
 * Bearer auth for the native shells is additive by design: with no token
 * stored — which is every web request, because `getNativeToken()` only ever
 * returns a value under Capacitor — the tRPC link must send exactly what it
 * sent before this existed. No `authorization` key, `credentials: "include"`,
 * and the same client label. That is the whole non-regression argument for
 * touching a file every screen in the app goes through, so it gets a test.
 */

type LinkOptions = {
  url: string;
  headers: () => Record<string, string>;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
};

const loadLink = async (options: {
  native: boolean;
  token: string | null;
}): Promise<LinkOptions> => {
  vi.resetModules();

  const captured: LinkOptions[] = [];

  vi.doMock("@trpc/client", () => ({
    httpBatchLink: (opts: LinkOptions) => {
      captured.push(opts);
      return opts;
    },
  }));
  vi.doMock("@trpc/react-query", () => ({
    createTRPCReact: () => ({
      createClient: (config: unknown) => config,
    }),
  }));
  vi.doMock("@/mobile/bridge", () => ({ isNative: () => options.native }));
  vi.doMock("@/lib/native-session", () => ({
    getNativeToken: () => options.token,
  }));

  const { getTRPCClient } = await import("@/lib/trpc");
  getTRPCClient();

  const link = captured[0];
  if (!link) throw new Error("httpBatchLink was never constructed");
  return link;
};

/** The RequestInit the link handed to `fetch`. */
const capturedInit = async (link: LinkOptions): Promise<RequestInit> => {
  let seen: RequestInit | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    seen = init;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;

  try {
    await link.fetch("http://api.example/api/trpc", { method: "POST" });
  } finally {
    globalThis.fetch = original;
  }

  if (!seen) throw new Error("fetch was never called");
  return seen;
};

beforeEach(() => {
  vi.resetModules();
});

describe("tRPC link on the web", () => {
  it("sends no authorization header", async () => {
    const link = await loadLink({ native: false, token: null });
    const headers = link.headers();

    expect(headers).toEqual({ "x-trackyourtime-client": "web" });
    expect("authorization" in headers).toBe(false);
  });

  it("still sends cookies", async () => {
    const link = await loadLink({ native: false, token: null });
    const init = await capturedInit(link);

    expect(init.credentials).toBe("include");
  });

  it("keeps the request method it was given", async () => {
    const link = await loadLink({ native: false, token: null });
    const init = await capturedInit(link);

    expect(init.method).toBe("POST");
  });
});

describe("tRPC link on native", () => {
  it("carries the session token as a bearer header", async () => {
    const link = await loadLink({ native: true, token: "session-token" });

    expect(link.headers()).toEqual({
      "x-trackyourtime-client": "trackyourtime-mobile",
      authorization: "Bearer session-token",
    });
  });

  it("omits credentials once a token is doing the work", async () => {
    const link = await loadLink({ native: true, token: "session-token" });
    const init = await capturedInit(link);

    expect(init.credentials).toBe("omit");
  });

  it("falls back to cookies before the Keychain has answered", async () => {
    // Hydration is asynchronous, so there is a window on every cold launch
    // where the shell is native but has no token yet. It must not start
    // omitting credentials on the strength of the platform alone.
    const link = await loadLink({ native: true, token: null });
    const init = await capturedInit(link);

    expect(init.credentials).toBe("include");
    expect("authorization" in link.headers()).toBe(false);
  });
});
