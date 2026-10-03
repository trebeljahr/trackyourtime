import { memoryStorage, type KeyValueStorage } from "@starter/core";
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryPersistence, isPersistedCatalog, QUERY_SNAPSHOT_KEY, SNAPSHOT_MAX_CHARS, SNAPSHOT_RETENTION_MS, SNAPSHOT_VERSION, type CacheScope } from "./query-persistence";

const scope: CacheScope = { server: "https://one.test", userId: "u1", workspaceId: "w1", access: "member:own" };
const key = (router = "projects", input: object = {}): QueryKey => [[router, "list"], { input, type: "query" }];
const project = [{ id: "p1", name: "Saved project" }];
const instant = 2_000_000_000_000;
const clients: QueryClient[] = [];
const client = () => { const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } }); clients.push(value); return value; };
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(instant); });
afterEach(() => { clients.splice(0).forEach((value) => value.clear()); vi.restoreAllMocks(); });
const envelope = (queries: { key: QueryKey; data: unknown[]; updatedAt: number }[] = [{ key: key(), data: project, updatedAt: instant - 1000 }], savedScope = scope, version = SNAPSHOT_VERSION) => JSON.stringify({ version, scope: savedScope, queries });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

async function savedFixture() {
  const store = memoryStorage();
  const c = client();
  const persistence = createQueryPersistence(c, store, () => instant);
  await persistence.activate(scope);
  await c.fetchQuery({ queryKey: key(), queryFn: async () => project });
  await persistence.settled();
  return { store, c, persistence };
}

describe("catalog persistence", () => {
  it("restores data on a repeat launch with its original age", async () => {
    const { store, persistence } = await savedFixture();
    persistence.dispose();
    const c = client();
    const next = createQueryPersistence(c, store, () => Date.now() + 10);
    await next.activate(scope);
    expect(c.getQueryData(key())).toEqual(project);
    expect(c.getQueryState(key())?.isInvalidated).toBe(true);
    next.dispose();
  });

  it("renders a saved list while refreshing despite infinite staleTime", async () => {
    const store = memoryStorage();
    await store.setItem(QUERY_SNAPSHOT_KEY, envelope());
    const c = client();
    const response = deferred<typeof project>();
    const observer = new QueryObserver(c, { queryKey: key(), queryFn: () => response.promise, staleTime: Infinity });
    const stop = observer.subscribe(() => {});
    const persistence = createQueryPersistence(c, store, () => instant);
    await persistence.activate(scope);
    expect(observer.getCurrentResult().data).toEqual(project);
    expect(observer.getCurrentResult().isFetching).toBe(true);
    response.resolve([{ id: "p2", name: "Fresh" }]);
    await observer.refetch();
    await persistence.settled();
    expect(c.getQueryData(key())).toEqual([{ id: "p2", name: "Fresh" }]);
    stop(); persistence.dispose();
  });

  it.each(["server", "userId", "workspaceId", "access"] as const)("never restores another %s", async (field) => {
    const store = memoryStorage();
    await store.setItem(QUERY_SNAPSHOT_KEY, envelope());
    const c = client();
    const persistence = createQueryPersistence(c, store, () => instant);
    await persistence.activate({ ...scope, [field]: "other" });
    expect(c.getQueryData(key())).toBeUndefined();
    expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it.each([
    ["expired", envelope([{ key: key(), data: project, updatedAt: instant - SNAPSHOT_RETENTION_MS }])],
    ["future", envelope([{ key: key(), data: project, updatedAt: instant + 1 }])],
    ["version", envelope(undefined, scope, 99)],
    ["malformed", "{"],
    ["shape", envelope([{ key: key(), data: [{}] as typeof project, updatedAt: instant }])],
    ["oversized", "x".repeat(SNAPSHOT_MAX_CHARS + 1)],
    ["credentials", envelope([{ key: key(), data: [{ id: "p1", name: "X", token: "secret" }], updatedAt: instant }])],
  ])("drops %s snapshots", async (_kind, raw) => {
    const store = memoryStorage(); await store.setItem(QUERY_SNAPSHOT_KEY, raw);
    const c = client(); const persistence = createQueryPersistence(c, store, () => instant);
    await persistence.activate(scope);
    expect(c.getQueryData(key())).toBeUndefined();
    expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it("ignores auth, timers, history, reports, filtered and explicit-workspace queries", async () => {
    const { c, persistence, store } = await savedFixture();
    const excluded = [key("entries"), key("profile"), key("apiTokens"), key("reports"), [["entries", "current"], { type: "query" }], key("projects", { workspaceId: "w2" }), key("projects", { includeArchived: true })];
    for (const queryKey of excluded) await c.fetchQuery({ queryKey, queryFn: async () => ({ token: "secret", running: "queued" }) });
    await persistence.settled();
    const raw = (await store.getItem(QUERY_SNAPSHOT_KEY))!;
    expect(JSON.parse(raw).queries).toHaveLength(1);
    expect(raw).not.toContain("secret"); expect(raw).not.toContain("queued");
    persistence.dispose();
  });

  it("keeps optimistic catalog edits out of disk and never overwrites in-memory timer/queue data", async () => {
    const { c, persistence, store } = await savedFixture();
    c.setQueryData(key(), [{ id: "temp", name: "Optimistic" }]);
    c.setQueryData([["entries", "current"], { type: "query" }], { id: "offline-timer" });
    await persistence.settled();
    expect((await store.getItem(QUERY_SNAPSHOT_KEY))!).not.toContain("Optimistic");
    await persistence.forget();
    expect(c.getQueryData([["entries", "current"], { type: "query" }])).toEqual({ id: "offline-timer" });
    persistence.dispose();
  });

  it("existing network or optimistic data wins over a delayed restore", async () => {
    const store = memoryStorage(); await store.setItem(QUERY_SNAPSHOT_KEY, envelope());
    const read = deferred<string | null>();
    const c = client(); const persistence = createQueryPersistence(c, { ...store, getItem: () => read.promise }, () => instant);
    const activation = persistence.activate(scope);
    await Promise.resolve();
    c.setQueryData(key(), [{ id: "new", name: "Newer" }]);
    read.resolve(envelope()); await activation;
    expect(c.getQueryData(key())).toEqual([{ id: "new", name: "Newer" }]);
    persistence.dispose();
  });

  it("bounds all four lists and excludes manual writes before a session is resolved", async () => {
    const store = memoryStorage(); const c = client(); const persistence = createQueryPersistence(c, store, () => instant);
    await c.fetchQuery({ queryKey: key(), queryFn: async () => project });
    expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    await persistence.activate(scope);
    for (const router of ["clients", "projects", "tasks", "tags"]) {
      const queryKey = key(router, router === "tags" ? { includeArchived: true } : {});
      await c.fetchQuery({ queryKey, queryFn: async () => project, staleTime: 0 });
    }
    await persistence.settled();
    expect(JSON.parse((await store.getItem(QUERY_SNAPSHOT_KEY))!).queries).toHaveLength(4);
    expect(isPersistedCatalog(key("tags", { includeArchived: true }))).toBe(true);
    persistence.dispose();
  });

  it("removes oversized responses instead of retaining a stale previous list", async () => {
    const { c, persistence, store } = await savedFixture();
    await c.fetchQuery({ queryKey: key(), queryFn: async () => [{ id: "p", name: "x".repeat(SNAPSHOT_MAX_CHARS) }], staleTime: 0 });
    await persistence.settled(); expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])("purges memory and disk on %s", async (code) => {
    const { c, persistence, store } = await savedFixture();
    await expect(c.fetchQuery({ queryKey: key(), staleTime: 0, queryFn: async () => { throw { data: { code } }; } })).rejects.toBeDefined();
    await persistence.settled();
    expect(c.getQueryData(key())).toBeUndefined(); expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it("purges catalogs when an unrelated query reports account revocation", async () => {
    const { c, persistence, store } = await savedFixture();
    await expect(c.fetchQuery({ queryKey: key("reports"), queryFn: async () => { throw { data: { code: "UNAUTHORIZED" } }; } })).rejects.toBeDefined();
    await persistence.settled();
    expect(c.getQueryData(key())).toBeUndefined();
    expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it("does not restore a delayed disk read after sign-out/deletion", async () => {
    const store = memoryStorage(); await store.setItem(QUERY_SNAPSHOT_KEY, envelope());
    const read = deferred<string | null>(); const c = client();
    const persistence = createQueryPersistence(c, { ...store, getItem: () => read.promise }, () => instant);
    const activation = persistence.activate(scope); await Promise.resolve(); await Promise.resolve();
    const cleanup = persistence.forget(); read.resolve(envelope());
    await activation; await cleanup;
    expect(c.getQueryData(key())).toBeUndefined(); expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it("cleanup follows an in-flight write and prevents resurrection", async () => {
    const store = memoryStorage(); const started = deferred<void>(); const release = deferred<void>();
    const backing: KeyValueStorage = { ...store, setItem: async (key, raw) => { started.resolve(); await release.promise; await store.setItem(key, raw); } };
    const c = client(); const persistence = createQueryPersistence(c, backing, () => instant);
    await persistence.activate(scope); await c.fetchQuery({ queryKey: key(), queryFn: async () => project });
    await started.promise; const cleanup = persistence.forget(); release.resolve(); await cleanup;
    expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull(); persistence.dispose();
  });

  it("a scope switch cancels the former account's late response", async () => {
    const store = memoryStorage(); const c = client(); const persistence = createQueryPersistence(c, store, () => instant);
    await persistence.activate(scope);
    const late = deferred<typeof project>();
    const request = c.fetchQuery({ queryKey: key(), queryFn: () => late.promise }).catch(() => undefined);
    await persistence.activate({ ...scope, userId: "u2" }); late.resolve(project); await request;
    await persistence.settled();
    expect(c.getQueryData(key())).toBeUndefined(); expect(await store.getItem(QUERY_SNAPSHOT_KEY)).toBeNull();
    persistence.dispose();
  });

  it("storage failures remain optional and do not prevent network data", async () => {
    const store: KeyValueStorage = { getItem: async () => { throw Error("denied"); }, setItem: async () => { throw Error("quota"); }, removeItem: async () => { throw Error("denied"); } };
    const c = client(); const persistence = createQueryPersistence(c, store, () => instant);
    await persistence.activate(scope); await c.fetchQuery({ queryKey: key(), queryFn: async () => project });
    await persistence.settled(); expect(c.getQueryData(key())).toEqual(project);
    await persistence.forget(); persistence.dispose();
  });
});
