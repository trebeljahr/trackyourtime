import type { Query, QueryClient } from "@tanstack/react-query";

export const FALLBACK_RESYNC_MS = 30_000;
export const HEALTHY_RESYNC_MS = 300_000;
export const HEALTH_LEASE_MS = 25_000;

// Keep reads tracked until decoded results, including streamed batches whose
// HTTP headers arrive before their queries finish.
const reads = new Set<{ sent: boolean }>();
export function trackSyncQuery(): () => void {
  const read = { sent: false };
  reads.add(read);
  return () => { reads.delete(read); };
}
const pendingRefreshes = new WeakMap<Query, { promise: Promise<unknown>; refresh: () => void }>();

/** Read immediately. Socket room placement reconciles snapshots sent before it. */
export function fetchSyncSnapshot<T>(query: boolean, fetch: () => Promise<T>): Promise<T> {
  if (query) for (const read of reads) read.sent = true;
  return fetch();
}

/** Queries already read (or sent) before the room was joined need catch-up. */
export function unsafeStartupQueries(client: QueryClient): Query[] {
  const inFlight = [...reads].some((read) => read.sent);
  return client.getQueryCache().getAll().filter((query) =>
    query.state.dataUpdatedAt > 0 || (inFlight && query.state.fetchStatus !== "idle"),
  );
}

/** Initial in-flight reads have no data to cancel; invalidate again after they settle. */
export function reconcileQueries(client: QueryClient, queries: Query[], stillCurrent: () => boolean): void {
  for (const query of queries) {
    const current = () => stillCurrent() && client.getQueryCache().get(query.queryHash) === query;
    if (!current()) continue;
    const pending = query.state.fetchStatus !== "idle" ? query.promise : undefined;
    const refresh = () => {
      if (current()) void client.invalidateQueries({ predicate: (candidate) => candidate === query });
    };
    if (!pending) {
      refresh();
      continue;
    }
    const previous = pendingRefreshes.get(query);
    if (previous?.promise === pending) {
      previous.refresh = refresh;
      continue;
    }
    const task = { promise: pending, refresh };
    pendingRefreshes.set(query, task);
    const settled = () => {
      if (pendingRefreshes.get(query) !== task) return;
      pendingRefreshes.delete(query);
      task.refresh();
    };
    void pending.then(settled, settled);
  }
}

export function needsSyncReconciliation(now: number, lastRefresh: number, distributedAt: number | null): boolean {
  const healthy = distributedAt !== null && now - distributedAt < HEALTH_LEASE_MS;
  // Called every 30s; leave one tick of slack to bound the healthy sweep.
  return !healthy || now - lastRefresh >= HEALTHY_RESYNC_MS - FALLBACK_RESYNC_MS;
}

/** Ensure an event arriving during an initial snapshot cannot be overwritten by it. */
export function reconcileInvalidatedReads(client: QueryClient, invalidate: () => void, stillCurrent: () => boolean): void {
  const pending = client.getQueryCache().getAll().filter((query) =>
    query.state.fetchStatus !== "idle" && query.state.dataUpdatedAt === 0,
  );
  invalidate();
  reconcileQueries(client, pending.filter((query) => query.state.isInvalidated), stillCurrent);
}
