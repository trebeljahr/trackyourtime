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
 *
 * The version handshake is the one deliberate change to that request: two
 * headers, `x-trackyourtime-client-version` and `x-trackyourtime-api-level`,
 * on every call (docs/versioning.md). They are spelled out below rather than
 * matched loosely, so a third header cannot slip in unnoticed.
 */
import { API_LEVEL } from "@starter/shared";

const VERSION_HEADERS = {
  "x-trackyourtime-client-version": "9.8.7",
  "x-trackyourtime-api-level": String(API_LEVEL),
};

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
  vi.doMock("@/lib/app-version", () => ({ APP_VERSION: "9.8.7" }));

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

    expect(headers).toEqual({ "x-trackyourtime-client": "web", ...VERSION_HEADERS });
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
      ...VERSION_HEADERS,
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

describe("version handshake", () => {
  it("never sends an empty or malformed version, but still declares the level", async () => {
    vi.resetModules();
    vi.doMock("@trpc/client", () => ({ httpBatchLink: (opts: LinkOptions) => opts }));
    vi.doMock("@trpc/react-query", () => ({
      createTRPCReact: () => ({ createClient: (config: { links: LinkOptions[] }) => config }),
    }));
    vi.doMock("@/mobile/bridge", () => ({ isNative: () => false }));
    vi.doMock("@/lib/native-session", () => ({ getNativeToken: () => null }));
    vi.doMock("@/lib/app-version", () => ({ APP_VERSION: "" }));
    const { getTRPCClient } = await import("@/lib/trpc");
    const config = getTRPCClient() as unknown as { links: LinkOptions[] };
    const link = config.links[1];
    if (!link) throw new Error("no http link");
    expect(link.headers()).toEqual({
      "x-trackyourtime-client": "web",
      "x-trackyourtime-api-level": String(API_LEVEL),
    });
    vi.doUnmock("@/lib/app-version");
  });
});

describe("workspace link", () => {
  type Op = { input: unknown; path: string };
  const run = async (input: unknown, active: string | null, ready = true): Promise<Op> => {
    vi.resetModules();
    vi.doMock("@/lib/active-workspace", () => ({
      getActiveWorkspaceId: () => active,
      isActiveWorkspaceReady: () => ready,
      whenActiveWorkspaceReady: async () => undefined,
    }));
    const { workspaceLink } = await import("@/lib/trpc");
    let seen: Op | undefined;
    const link = workspaceLink()({} as never);
    link({
      op: { input, path: "entries.list" } as never,
      next: ((op: Op) => {
        seen = op;
        return undefined as never;
      }) as never,
    });
    vi.doUnmock("@/lib/active-workspace");
    if (!seen) throw new Error("next was never called");
    return seen;
  };

  it("adds the active workspace to an input that names none", async () => {
    expect((await run({ limit: 5 }, "ws-b")).input).toEqual({ limit: 5, workspaceId: "ws-b" });
    expect((await run(undefined, "ws-b")).input).toEqual({ workspaceId: "ws-b" });
  });

  it("never overrides an explicit workspace — a replayed row keeps its own", async () => {
    expect((await run({ workspaceId: "ws-a" }, "ws-b")).input).toEqual({ workspaceId: "ws-a" });
  });

  it("passes the operation through untouched when no workspace is resolved", async () => {
    const input = { limit: 5 };
    expect((await run(input, null)).input).toBe(input);
  });

  it("marks an operation that got ahead of the stored choice, and the fetch settles it", async () => {
    const { input } = await run({ limit: 5 }, null, false);
    const { PENDING_WORKSPACE, settlePendingWorkspace } = await import("@/lib/trpc");
    expect(input).toEqual({ limit: 5, workspaceId: PENDING_WORKSPACE });

    const body = JSON.stringify({ 0: input, 1: { workspaceId: "ws-a" } });
    const settled = settlePendingWorkspace("https://api.example/api/trpc/a,b?batch=1", { method: "POST", body }, "ws-b");
    expect(JSON.parse(String(settled.init?.body))).toEqual({
      0: { limit: 5, workspaceId: "ws-b" },
      1: { workspaceId: "ws-a" },
    });

    const query = encodeURIComponent(JSON.stringify({ 0: input }));
    const fromUrl = settlePendingWorkspace(`/api/trpc/a?batch=1&input=${query}`, { method: "GET" }, null);
    const parsed = new URL(fromUrl.url, "http://x.invalid").searchParams.get("input");
    // Still unresolved: the marker is dropped, never sent.
    expect(JSON.parse(parsed ?? "null")).toEqual({ 0: { limit: 5 } });
  });

  it("leaves a request with no marker byte-identical", async () => {
    const { settlePendingWorkspace } = await import("@/lib/trpc");
    const init = { method: "POST", body: JSON.stringify({ 0: { id: "1" } }) };
    const settled = settlePendingWorkspace("https://api.example/api/trpc/a?batch=1", init, "ws-b");
    expect(settled.init).toBe(init);
    expect(settled.url).toBe("https://api.example/api/trpc/a?batch=1");
  });
});

describe("the CLIENT_TOO_OLD refusal", () => {
  it("is read from a batched or single tRPC error body, and nothing else", async () => {
    const { isClientTooOldBody } = await import("@/lib/trpc");
    const refusal = {
      error: { message: "x", code: -32012, data: { code: "PRECONDITION_FAILED", httpStatus: 412, versionRefusal: "CLIENT_TOO_OLD" } },
    };
    expect(isClientTooOldBody([{ result: { data: 1 } }, refusal])).toBe(true);
    expect(isClientTooOldBody(refusal)).toBe(true);
    expect(isClientTooOldBody({ error: { json: refusal.error } })).toBe(true);
    expect(
      isClientTooOldBody([{ error: { data: { code: "PRECONDITION_FAILED", httpStatus: 412, versionRefusal: null } } }]),
    ).toBe(false);
    expect(isClientTooOldBody("<html>")).toBe(false);
  });
});
