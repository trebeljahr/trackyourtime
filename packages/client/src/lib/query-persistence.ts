import type { KeyValueStorage } from "@starter/core";
import { hashKey, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

export const QUERY_SNAPSHOT_KEY = "trackyourtime.catalog-snapshot";
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_MAX_CHARS = 128 * 1024; // At most 256 KiB of UTF-16 storage.

export type CacheScope = { server: string; userId: string; workspaceId: string; access: string };
type SavedQuery = { key: QueryKey; data: unknown[]; updatedAt: number };
type Snapshot = { version: number; scope: CacheScope; queries: SavedQuery[] };

const scopeKey = (scope: CacheScope | null): string => JSON.stringify(scope && [scope.server, scope.userId, scope.workspaceId, scope.access]);

/** Only the four tracker picker lists. No entries, sessions, tokens or mutations. */
export const isPersistedCatalog = (key: QueryKey): boolean => {
  const [path, options] = key;
  if (key.length !== 2 || !Array.isArray(path) || path.length !== 2) return false;
  if (!["clients", "projects", "tasks", "tags"].includes(path[0]) || path[1] !== "list") return false;
  if (!options || typeof options !== "object") return false;
  const { input, type, ...extra } = options as Record<string, unknown>;
  if (type !== "query" || Object.keys(extra).length || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = Object.keys(input);
  return path[0] === "tags"
    ? fields.length === 1 && (input as { includeArchived?: unknown }).includeArchived === true
    : fields.length === 0;
};

const validData = (data: unknown): data is unknown[] =>
  Array.isArray(data) && data.length <= 1000 && data.every((row) =>
    row !== null && typeof row === "object" && typeof row.id === "string" && typeof row.name === "string",
  ) && !/"(?:token|accessToken|refreshToken|sessionToken|password|authorization)"\s*:/i.test(JSON.stringify(data));

const decode = (raw: string | null, scope: CacheScope, now: number): SavedQuery[] => {
  if (!raw || raw.length > SNAPSHOT_MAX_CHARS) return [];
  try {
    const saved = JSON.parse(raw) as Snapshot;
    if (saved.version !== SNAPSHOT_VERSION || scopeKey(saved.scope) !== scopeKey(scope) || !Array.isArray(saved.queries) || saved.queries.length > 4) return [];
    const seen = new Set<string>();
    return saved.queries.filter((row) => {
      if (!row || !Array.isArray(row.key) || !isPersistedCatalog(row.key) || !validData(row.data)) return false;
      if (!Number.isFinite(row.updatedAt) || row.updatedAt <= 0 || row.updatedAt > now || now - row.updatedAt >= SNAPSHOT_RETENTION_MS) return false;
      const key = hashKey(row.key);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch { return []; }
};

/** One bounded envelope; serialized writes and epochs prevent delayed work resurrecting it. */
export function createQueryPersistence(client: QueryClient, storage: KeyValueStorage, now = Date.now) {
  let scope: CacheScope | null = null;
  let epoch = 0;
  let accepting = false;
  let rows = new Map<string, SavedQuery>();
  const fetchEpoch = new WeakMap<Query, number>();
  let io: Promise<void> = Promise.resolve();
  const serialize = (work: () => Promise<void>): Promise<void> => {
    io = io.then(work, work).catch(() => undefined);
    return io;
  };
  const filters = { predicate: (query: Query) => isPersistedCatalog(query.queryKey) };
  const reset = () => {
    for (const query of client.getQueryCache().findAll(filters)) query.reset();
  };
  const save = () => {
    const at = epoch;
    const captured = scope;
    const queries = [...rows.values()].filter((row) => now() - row.updatedAt < SNAPSHOT_RETENTION_MS);
    const raw = JSON.stringify({ version: SNAPSHOT_VERSION, scope: captured, queries });
    return serialize(async () => {
      if (epoch !== at || !captured || !accepting) return;
      if (raw.length <= SNAPSHOT_MAX_CHARS && queries.length) await storage.setItem(QUERY_SNAPSHOT_KEY, raw);
      else await storage.removeItem(QUERY_SNAPSHOT_KEY);
    });
  };
  const forget = (): Promise<void> => {
    epoch++;
    scope = null;
    accepting = false;
    rows.clear();
    // Stop before resetting: cancellation may publish the old successful state.
    const cancelled = client.cancelQueries(filters);
    reset();
    return serialize(async () => {
      await cancelled;
      await storage.removeItem(QUERY_SNAPSHOT_KEY);
    });
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { query, action } = event;
    const path = query.queryKey[0];
    if (action.type === "error") {
      const code = (action.error as { data?: { code?: string } })?.data?.code;
      const scoped = isPersistedCatalog(query.queryKey) || (Array.isArray(path) && path[0] === "workspaces");
      if (code === "UNAUTHORIZED" || (scoped && ["FORBIDDEN", "NOT_FOUND"].includes(code ?? ""))) void forget();
      return;
    }
    if (!accepting || !scope || !isPersistedCatalog(query.queryKey)) return;
    if (action.type === "fetch") fetchEpoch.set(query, epoch);
    // setQueryData is optimistic/manual: never snapshot it, even after rollback.
    if (action.type !== "success" || action.manual || fetchEpoch.get(query) !== epoch) return;
    if (!validData(query.state.data)) {
      rows.delete(hashKey(query.queryKey));
      void save();
      return;
    }
    rows.set(hashKey(query.queryKey), { key: query.queryKey, data: query.state.data, updatedAt: query.state.dataUpdatedAt });
    void save();
  });

  return {
    /** Caller supplies a resolved session and fresh server membership; disk grants no access. */
    async activate(next: CacheScope): Promise<void> {
      if (scopeKey(scope) === scopeKey(next)) return;
      const at = ++epoch;
      const changing = scope !== null;
      accepting = false;
      scope = next;
      rows = new Map();
      await client.cancelQueries(filters);
      if (at !== epoch) return;
      if (changing) reset();
      await serialize(async () => {
        const raw = await storage.getItem(QUERY_SNAPSHOT_KEY);
        if (at !== epoch) return;
        const saved = decode(raw, next, now());
        if (!saved.length && raw) await storage.removeItem(QUERY_SNAPSHOT_KEY);
        if (at !== epoch) return;
        for (const row of saved) {
          // Network/manual data already in memory always wins over disk.
          if (client.getQueryData(row.key) !== undefined) continue;
          client.setQueryData(row.key, row.data, { updatedAt: row.updatedAt });
          rows.set(hashKey(row.key), row);
        }
      });
      if (at !== epoch) return;
      accepting = true;
      // Retained data renders immediately; staleTime defaults cannot suppress refresh.
      void client.invalidateQueries(filters);
    },
    /** Pause on route/scope changes without discarding the next launch's snapshot. */
    pause(): void {
      epoch++;
      accepting = false;
      const wasActive = scope !== null;
      scope = null;
      rows.clear();
      if (wasActive) {
        void client.cancelQueries(filters);
        reset();
      }
    },
    forget,
    settled: () => io,
    dispose(): void { epoch++; accepting = false; unsubscribe(); },
  };
}
export type QueryPersistence = ReturnType<typeof createQueryPersistence>;
