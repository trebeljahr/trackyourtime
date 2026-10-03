import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUntypedClient, TRPCClientError } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createHTTPServer } from "@trpc/server/adapters/standalone";

const nativeFetch = globalThis.fetch;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

let shell: "web" | "capacitor" | "electron";
let token: string | null;
let workspace: string | null;
let workspaceReady: boolean;
let originReady: Promise<void>;
let workspaceSettled: Promise<void>;
const refused = vi.fn();
const requests: Request[] = [];
const credentials: (RequestCredentials | undefined)[] = [];
const statuses: number[] = [];

const loadClient = async (streamQueries = true) => {
  vi.doMock("@/lib/shell", async () =>
    (await import("@/lib/shell-mock")).mockShellModule(() => shell));
  vi.doMock("@/lib/native-session", () => ({ getNativeToken: () => token }));
  vi.doMock("@/lib/active-workspace", () => ({
    getActiveWorkspaceId: () => workspace,
    isActiveWorkspaceReady: () => workspaceReady,
    whenActiveWorkspaceReady: () => workspaceSettled,
  }));
  vi.doMock("@/lib/api-origin", () => ({
    whenApiOriginReady: () => originReady,
    rebaseApiUrl: (url: string) => {
      const parsed = new URL(url, "https://build.invalid");
      return `https://chosen.invalid${parsed.pathname}${parsed.search}`;
    },
  }));
  vi.doMock("@/lib/server-level", () => ({
    currentServerApiLevel: () => null,
    noteClientTooOld: refused,
  }));
  vi.doMock("@/lib/app-version", () => ({ APP_VERSION: "9.8.7" }));
  const { getTRPCClient } = await import("@/lib/trpc");
  return getUntypedClient(getTRPCClient({ streamQueries }));
};

const t = initTRPC.create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, versionRefusal: error.cause?.message ?? null },
  }),
});

const serve = (slow = deferred(), started = deferred()) => {
  const router = t.router({
    fast: t.procedure.query(() => "useful data"),
    slow: t.procedure.query(async () => {
      started.resolve();
      await slow.promise;
      return "slow data";
    }),
    echo: t.procedure.input((value: unknown) => value).query(({ input }) => input),
    denied: t.procedure.query(() => { throw new TRPCError({ code: "UNAUTHORIZED" }); }),
    refused: t.procedure.query(() => {
      throw new TRPCError({ code: "PRECONDITION_FAILED", cause: new Error("CLIENT_TOO_OLD") });
    }),
    precondition: t.procedure.query(() => { throw new TRPCError({ code: "PRECONDITION_FAILED" }); }),
    mutate: t.procedure.mutation(() => "saved"),
  });
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    credentials.push(init?.credentials);
    const request = new Request(new URL(String(url), "https://build.invalid"), init);
    requests.push(request);
    const response = await fetchRequestHandler({ endpoint: "/api/trpc", req: request, router });
    statuses.push(response.status);
    return response;
  });
  return router;
};

beforeEach(() => {
  vi.resetModules();
  shell = "web";
  token = null;
  workspace = null;
  workspaceReady = true;
  originReady = Promise.resolve();
  workspaceSettled = Promise.resolve();
  refused.mockClear();
  requests.length = credentials.length = statuses.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of ["shell", "native-session", "active-workspace", "api-origin", "server-level", "app-version"]) {
    vi.doUnmock(`@/lib/${path}`);
  }
});

describe("real tRPC batch transport", () => {
  it("delivers fast data over a real HTTP response before the slow query completes", async () => {
    const slow = deferred();
    const server = createHTTPServer({ router: serve(slow), basePath: "/api/trpc/" });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    let response: Response | undefined;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url), "https://build.invalid");
      const request = new Request(`http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`, init);
      requests.push(request);
      response = await nativeFetch(request);
      return response;
    });
    const client = await loadClient();
    let slowDone = false;
    const pending = client.query("slow").then((value) => { slowDone = true; return value; });
    try {
      expect(await client.query("fast", undefined, { signal: AbortSignal.timeout(2000) })).toBe("useful data");
      expect(slowDone).toBe(false);
      expect(requests).toHaveLength(1);
      expect(response?.headers.get("transfer-encoding")).toBe("chunked");
      expect(response?.headers.get("content-length")).toBeNull();
      expect(response?.status).toBe(200);
    } finally {
      slow.resolve();
      await pending;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["web", "capacitor", "electron"] as const)("%s delivers fast data while slow query remains held in the same batch", async (kind) => {
    shell = kind;
    token = kind === "web" ? null : "session-token";
    const slow = deferred();
    serve(slow);
    const client = await loadClient();
    let slowDone = false;
    // Put slow first: completion must not depend on operation order.
    const pending = client.query("slow").then((value) => { slowDone = true; return value; });
    try {
      expect(await client.query("fast")).toBe("useful data");
      expect(slowDone).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toContain("slow,fast?batch=1");
      expect(requests[0].headers.get("accept")).toBe("application/jsonl");
      expect(requests[0].headers.get("trpc-accept")).toBeNull();
      expect(requests[0].headers.get("authorization")).toBe(token ? `Bearer ${token}` : null);
      expect(credentials).toEqual([token ? "omit" : "include"]);
    } finally {
      slow.resolve();
      expect(await pending).toBe("slow data");
    }
  });

  it.each(["opt-out", "old WebView", "operation opt-out"])("%s retains ordinary JSON batches", async (mode) => {
    if (mode === "old WebView") {
      shell = "capacitor";
      vi.stubGlobal("TextDecoderStream", undefined);
    }
    const slow = deferred();
    const started = deferred();
    serve(slow, started);
    const client = await loadClient(mode !== "opt-out");
    const options = mode === "operation opt-out" ? { context: { skipStreaming: true } } : undefined;
    let fastDone = false;
    const pending = client.query("slow", undefined, options);
    const fast = client.query("fast", undefined, options).then((value) => { fastDone = true; return value; });
    try {
      await started.promise;
      expect(fastDone).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get("accept")).toBeNull();
    } finally {
      slow.resolve();
      expect(await fast).toBe("useful data");
      expect(await pending).toBe("slow data");
    }
  });

  it("keeps mutations on the JSON path", async () => {
    serve();
    const client = await loadClient();
    expect(await client.mutation("mutate")).toBe("saved");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("accept")).toBeNull();
    expect(statuses).toEqual([200]);
  });

  it.each([true, false])("preserves per-operation failure and version refusal (streaming=%s)", async (streaming) => {
    serve();
    const client = await loadClient(streaming);
    const results = await Promise.allSettled([
      client.query("fast"), client.query("denied"), client.query("refused"), client.query("precondition"),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "useful data" });
    for (const [index, code, status] of [[1, "UNAUTHORIZED", 401], [2, "PRECONDITION_FAILED", 412], [3, "PRECONDITION_FAILED", 412]] as const) {
      const result = results[index];
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(TRPCClientError);
        expect(result.reason.data).toMatchObject({ code, httpStatus: status });
      }
    }
    expect(requests).toHaveLength(1);
    expect(statuses).toEqual([streaming ? 200 : 207]);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("detects a plain JSON 412 and keeps its HTTP status", async () => {
    serve();
    const client = await loadClient(false);
    await expect(client.query("refused")).rejects.toMatchObject({ data: { httpStatus: 412 } });
    expect(statuses).toEqual([412]);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("does not flag an unrelated precondition error", async () => {
    serve();
    const client = await loadClient();
    await expect(client.query("precondition")).rejects.toMatchObject({ data: { httpStatus: 412 } });
    expect(refused).not.toHaveBeenCalled();
  });

  it("handles a nonstreaming JSON 412 returned to a streaming request", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: {
      message: "Update required", code: -32012,
      data: { code: "PRECONDITION_FAILED", httpStatus: 412, versionRefusal: "CLIENT_TOO_OLD" },
    } }), { status: 412, headers: { "content-type": "application/json" } }));
    const client = await loadClient();
    await expect(client.query("fast")).rejects.toMatchObject({ data: { httpStatus: 412 } });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it.each([200, 502])("propagates malformed/proxy responses (status=%s)", async (status) => {
    vi.stubGlobal("fetch", async () => new Response("<html>proxy error</html>", { status }));
    const client = await loadClient();
    await expect(client.query("fast")).rejects.toBeInstanceOf(TRPCClientError);
    expect(refused).not.toHaveBeenCalled();
  });

  it("propagates transport failures without a version refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const client = await loadClient();
    await expect(client.query("fast")).rejects.toThrow("offline");
    expect(refused).not.toHaveBeenCalled();
  });

  it.each([true, false])("native waits for selected origin/workspace and captures latest token (streaming=%s)", async (streaming) => {
    shell = "capacitor";
    token = "old-token";
    workspaceReady = false;
    const origin = deferred();
    const settled = deferred();
    originReady = origin.promise;
    workspaceSettled = settled.promise;
    serve();
    const client = await loadClient(streaming);
    const pending = client.query("echo", { limit: 5 });
    // Let the batch scheduler reach the readiness gate.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    origin.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(0);
    token = "new-token";
    workspace = "selected-workspace";
    workspaceReady = true;
    settled.resolve();
    expect(await pending).toEqual({ limit: 5, workspaceId: "selected-workspace" });
    expect(requests[0].url).toContain("https://chosen.invalid/api/trpc/");
    expect(requests[0].url).not.toContain("pending-workspace");
    expect(requests[0].headers.get("authorization")).toBe("Bearer new-token");
    expect(requests[0].headers.get("x-trackyourtime-client")).toBe("trackyourtime-mobile");
    expect(requests[0].headers.get("x-trackyourtime-client-version")).toBe("9.8.7");
    expect(credentials).toEqual(["omit"]);
  });
});
