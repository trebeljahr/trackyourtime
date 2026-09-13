import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike } from "../api-client.js";
import type { McpConfig } from "../config.js";
import { createServer, type CreatedServer } from "../server.js";

export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeRoute = (request: RecordedRequest) => { status: number; body: unknown; headers?: Record<string, string> };

/**
 * A stand-in for `/api/v1` keyed by "METHOD /path". Unknown routes answer the
 * same 404 problem the real router does, so a tool calling the wrong path fails
 * the test instead of passing on an accidental default.
 */
export function fakeApi(routes: Record<string, FakeRoute>): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const route = routes[`${request.method} ${path}`];
    const answer = route
      ? route(request)
      : {
          status: 404,
          body: {
            type: "https://trackyourtime.dev/problems/not-found",
            title: "Not Found",
            status: 404,
            detail: `No API route matches ${request.method} ${url.pathname}.`,
            instance: url.pathname,
          },
        };
    const isProblem = answer.status >= 400;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: {
        "content-type": isProblem ? "application/problem+json" : "application/json",
        ...answer.headers,
      },
    });
  };
  return { fetch: fetchImpl, requests };
}

export function meRoute(scopes: string[]): FakeRoute {
  return () => ({
    status: 200,
    body: {
      data: {
        tokenId: "t1",
        workspaceId: "w1",
        userId: "u1",
        scopes,
        visibility: { canViewOthersTime: false, canViewOthersMoney: false },
      },
    },
  });
}

export const CONFIG: McpConfig = { apiUrl: "https://api.example.test", token: "tt_test_secret" };

export async function connect(
  fetchImpl: FetchLike,
  config: McpConfig = CONFIG,
): Promise<{ client: Client; created: CreatedServer; close: () => Promise<void> }> {
  const created = await createServer(config, { fetch: fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    created,
    close: async () => {
      await client.close();
      await created.server.close();
    },
  };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}
