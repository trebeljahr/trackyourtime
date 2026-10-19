import type { Db } from "mongodb";
import type { Migration } from "./types.js";

type Keys = Record<string, 1 | -1>;

/** What `listIndexes` reports, as far as this migration reads it. */
type StoredIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
  expireAfterSeconds?: number;
  hidden?: boolean;
};

/**
 * Indexes a later release replaced with the same keys plus `_id: -1`, the
 * keyset tie-break, so a page seeks to its cursor instead of sorting. The
 * boot index builder only ever adds (it must not drop what a newer release
 * declared), so an upgraded database still carries each old one: a prefix of
 * its replacement, serving nothing the replacement does not, and costing a
 * write on every insert and update.
 *
 * Raw collection names, as mongoose names them: a migration never imports
 * today's models.
 */
export const SUPERSEDED_INDEXES: readonly { collection: string; old: Keys; replacement: Keys }[] = [
  // 823cabad
  {
    collection: "timeentries",
    old: { workspaceId: 1, start: -1 },
    replacement: { workspaceId: 1, start: -1, _id: -1 },
  },
  {
    collection: "timeentries",
    old: { workspaceId: 1, authorId: 1, start: -1 },
    replacement: { workspaceId: 1, authorId: 1, start: -1, _id: -1 },
  },
  // f84e7c2b
  {
    collection: "invoices",
    old: { workspaceId: 1, createdAt: -1 },
    replacement: { workspaceId: 1, createdAt: -1, _id: -1 },
  },
  {
    collection: "invoices",
    old: { workspaceId: 1, status: 1, createdAt: -1 },
    replacement: { workspaceId: 1, status: 1, createdAt: -1, _id: -1 },
  },
  {
    collection: "invoices",
    old: { workspaceId: 1, clientId: 1, createdAt: -1 },
    replacement: { workspaceId: 1, clientId: 1, createdAt: -1, _id: -1 },
  },
  {
    collection: "webhookdeliveries",
    old: { subscriptionId: 1, createdAt: -1 },
    replacement: { subscriptionId: 1, createdAt: -1, _id: -1 },
  },
];

/** Same fields, same order, same directions. */
const sameKeys = (a: Record<string, unknown>, b: Keys): boolean => {
  const left = Object.entries(a);
  const right = Object.entries(b);
  return left.length === right.length && left.every(([field, dir], i) => field === right[i]![0] && Number(dir) === right[i]![1]);
};

/**
 * A plain index covers every document, adds no rule and serves queries.
 * Anything else under these keys — unique, partial, sparse, a collation, a
 * TTL, hidden from the planner — was made so by somebody for a reason this
 * migration cannot see, so it is left alone, and so is an old index whose
 * replacement is not plain.
 */
const isPlain = (index: StoredIndex): boolean =>
  !index.unique &&
  !index.sparse &&
  index.partialFilterExpression === undefined &&
  index.collation === undefined &&
  index.expireAfterSeconds === undefined &&
  index.hidden !== true;

const isNamespaceNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 26;

const isIndexNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 27;

/**
 * Drops each old index, after making sure its replacement exists.
 *
 * Indexes only: no document is read for its content, written or deleted. The
 * replacement is built first, with the keys and default name the schema
 * gives it, because migrations run before the boot index build: a database
 * last started by a release older than the replacement must never be left
 * without either. A replacement that cannot be built, or an old index that
 * cannot be dropped, is reported and kept — a leftover index is harmless and
 * must not stop the server.
 *
 * Readable by every release (`minReaderSchema` 0): an older build only ever
 * reads through these indexes, and its own boot rebuilds the ones it declares.
 *
 * Idempotent: a re-run finds nothing to drop.
 */
export const dropSupersededIndexes: Migration = {
  id: 3,
  description: "drop the indexes superseded by `_id`-suffixed keyset indexes",
  minReaderSchema: 0,
  up: async (db: Db) => {
    for (const { collection, old, replacement } of SUPERSEDED_INDEXES) {
      let indexes: StoredIndex[];
      try {
        indexes = (await db.collection(collection).listIndexes().toArray()) as StoredIndex[];
      } catch (error) {
        // A collection nothing has written to yet holds no index to drop.
        if (isNamespaceNotFound(error)) continue;
        throw error;
      }
      const stale = indexes.find((index) => sameKeys(index.key, old));
      if (!stale?.name || !isPlain(stale)) continue;

      const current = indexes.find((index) => sameKeys(index.key, replacement));
      if (current && !isPlain(current)) continue;
      if (!current) {
        try {
          await db.collection(collection).createIndex(replacement);
        } catch (error) {
          console.warn(
            `[migrations] Kept ${collection}.${stale.name}: its replacement ${JSON.stringify(replacement)} could not be built: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }

      try {
        await db.collection(collection).dropIndex(stale.name);
      } catch (error) {
        if (isIndexNotFound(error)) continue;
        console.warn(
          `[migrations] Kept ${collection}.${stale.name}, which ${JSON.stringify(replacement)} supersedes; drop it by hand: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
};
