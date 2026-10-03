// @vitest-environment jsdom
import * as React from "react";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
vi.mock("@/hooks/use-native-session", () => ({ useNativeSession: () => ({ ready: true, token: null }) }));
vi.mock("@/hooks/use-api-origin", () => ({ useApiOrigin: () => ({ choice: null }) }));
vi.mock("@/lib/native-session", () => ({ getNativeToken: () => null }));
vi.mock("@/lib/auth-client", () => ({ onSignOut: () => () => {} }));
vi.mock("@/lib/running-mirror", () => ({ writeRunningMirror: async () => {} }));
vi.mock("@/lib/idle-watcher", () => ({ idleWatcher: { noteRemoteActivity: vi.fn() } }));
vi.mock("@/lib/revoke-this-device", () => ({ revokeThisDevice: vi.fn() }));
vi.mock("@/lib/api-origin", () => ({ getApiOrigin: () => "", whenApiOriginReady: async () => {}, rebaseApiUrl: (url: string) => url }));
let workspace = "ws-a";
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => workspace, isActiveWorkspaceReady: () => true, whenActiveWorkspaceReady: async () => {} }));
vi.mock("@/lib/server-level", () => ({ currentServerApiLevel: () => null, noteClientTooOld: vi.fn() }));
vi.mock("@/lib/shell", () => ({ clientId: () => "web", isTokenShell: () => false }));

const { trpc, getTRPCClient } = await import("@/lib/trpc");
const { useSync, ORIGIN_ID } = await import("./use-sync");
const sockets: Socket[] = [];
class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  constructor() { sockets.push(this); }
  close() {}
  open() { this.onopen?.(); }
  state(distributed = true) { this.onmessage?.({ data: JSON.stringify({ type: "tt:sync-state", distributed }) }); }
  event(workspaceId = workspace, originId?: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "tt:sync", event: { kind: "entry.deleted", id: "entry" }, workspaceId, originId }) });
  }
}
let value = "before", heldResponse = false, count = 0;
let reply: (() => void) | undefined;
const result = (snapshot: string) => new Response(JSON.stringify([{ result: { data: snapshot } }]));
const advance = async (ms = 1) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function Reader() { trpc.entries.current.useQuery(undefined, { staleTime: Infinity }); return null; }
function Shell() { useSync(); return <Reader />; }
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<trpc.Provider client={getTRPCClient({ streamQueries: false })} queryClient={client}><QueryClientProvider client={client}><Shell /></QueryClientProvider></trpc.Provider>);
  return client;
}
beforeEach(() => {
  vi.useFakeTimers(); sockets.length = 0; count = 0; workspace = "ws-a";
  value = "before"; heldResponse = false; reply = undefined;
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => {
    count += 1; const snapshot = value;
    if (heldResponse) { heldResponse = false; return new Promise<Response>((done) => { reply = () => done(result(snapshot)); }); }
    return Promise.resolve(result(snapshot));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("cold startup sends one snapshot after room join, no open or healthy 30s refetch", async () => {
  mount(); await advance(); expect(count).toBe(0);
  sockets[0]!.open(); await advance(); expect(count).toBe(0);
  sockets[0]!.state(); await advance(); expect(count).toBe(1);
  for (let i = 0; i < 3; i++) { await advance(10_000); sockets[0]!.state(); }
  expect(count).toBe(1);
});
it("cached pre-subscription data is refreshed once", async () => {
  const client = new QueryClient(); client.setQueryData([["entries", "current"], { type: "query" }], "cached");
  mount(client); await advance(); expect(count).toBe(0);
  sockets[0]!.open(); sockets[0]!.state(); await advance(); expect(count).toBe(1);
});
it("reconnect catches missed writes once; old socket frames cannot refetch", async () => {
  const client = mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  sockets[0]!.onclose?.(); value = "after"; await advance(1100);
  expect(sockets).toHaveLength(2); sockets[1]!.open(); sockets[1]!.state(); await advance();
  expect(count).toBe(2); expect(client.getQueryCache().getAll()[0]?.state.data).toBe("after");
  sockets[0]!.state(); sockets[0]!.event(); await advance(); expect(count).toBe(2);
});
it("offline/legacy startup releases within one second and retains fallback polling", async () => {
  mount(); await advance(1001); expect(count).toBe(1);
  await advance(30_000); expect(count).toBe(2);
  sockets[0]!.open(); await advance(1001); expect(count).toBe(3);
});
it("health lease loss restores polling; healthy feed still sweeps", async () => {
  mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  await advance(30_000); expect(count).toBe(2);
  sockets[0]!.state(false); await advance(30_000); expect(count).toBe(3);
  for (let i = 0; i < 30; i++) { sockets[0]!.state(); await advance(10_000); }
  expect(count).toBe(5);
});
it("event during initial snapshot cannot be overwritten by old response", async () => {
  heldResponse = true; const client = mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  expect(count).toBe(1); value = "after"; sockets[0]!.event(); sockets[0]!.event(); reply?.(); await advance();
  expect(count).toBe(2); expect(client.getQueryCache().getAll()[0]?.state.data).toBe("after");
});
it("workspace switch cancels deferred reconciliation for prior workspace", async () => {
  heldResponse = true; const client = mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  sockets[0]!.event(); workspace = "ws-b"; client.clear(); reply?.(); await advance(); expect(count).toBe(1);
});
it("other-workspace entries refresh personal timer; own echoes are skipped", async () => {
  mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  sockets[0]!.event("ws-b", ORIGIN_ID); await advance(); expect(count).toBe(1);
  sockets[0]!.event("ws-b"); await advance(); expect(count).toBe(2);
});

it("query sent before shell subscription gets a second snapshot after its response settles", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = getTRPCClient({ streamQueries: false });
  heldResponse = true;
  const initial = client.fetchQuery({
    queryKey: [["entries", "current"], { type: "query" }],
    queryFn: () => api.entries.current.query(),
    staleTime: Infinity,
  });
  await advance(); expect(count).toBe(1);
  mount(client); sockets[0]!.open(); sockets[0]!.state(); value = "after";
  reply?.(); await initial; await advance();
  expect(count).toBe(2); expect(client.getQueryCache().getAll()[0]?.state.data).toBe("after");
});

it("stream headers before subscription do not hide an unfinished snapshot", async () => {
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  let first = true;
  const t = initTRPC.create();
  const router = t.router({ entries: t.router({ current: t.procedure.query(async () => {
    const snapshot = value;
    if (first) { first = false; await pending; }
    return snapshot;
  }) }) });
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    count += 1;
    return fetchRequestHandler({ endpoint: "/api/trpc", router, req: new Request(new URL(String(url), "https://test.invalid"), init) });
  });
  const client = new QueryClient();
  const api = getTRPCClient();
  const initial = client.fetchQuery({ queryKey: [["entries", "current"], { type: "query" }], queryFn: () => api.entries.current.query(), staleTime: Infinity });
  await advance(); expect(count).toBe(1);
  mount(client); sockets[0]!.open(); sockets[0]!.state(); value = "after";
  release(); await initial; await advance();
  expect(count).toBe(2); expect(client.getQueryCache().getAll()[0]?.state.data).toBe("after");
});

it("Redis recovery catches missed writes before returning to healthy cadence", async () => {
  const client = mount(); sockets[0]!.open(); sockets[0]!.state(); await advance();
  sockets[0]!.state(false); value = "missed-during-gap";
  sockets[0]!.state(true); await advance();
  expect(count).toBe(2); expect(client.getQueryCache().getAll()[0]?.state.data).toBe("missed-during-gap");
});
