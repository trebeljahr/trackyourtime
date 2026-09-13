// The row store every membership operation runs against.
//
// Injected, and deliberately dumb — find, insert, update and delete by filter —
// for the same reason the account-deletion cascade is: the judgement (which
// record is written first, what a retry after a crash does, who may do what)
// then runs in the unit suite against in-memory rows, and the two real stores
// behind it (`stores.ts`) stay thin enough to read in one sitting.
//
// Types only. `stores.ts` imports better-auth and mongoose; this file must not,
// because the account-deletion cascade (loaded by `auth/auth.ts` itself)
// imports the helpers typed here.

/**
 * Everything membership reads or writes.
 *
 * `workspaceMembers` is the app-owned mirror (mongoose). Every `auth*` name is
 * one of better-auth's own tables, written through its adapter so ids are
 * stored the way the plugin stores them.
 */
export type MembershipCollection =
  | "workspaceMembers"
  | "authMembers"
  | "authInvitations"
  | "authOrganizations"
  | "authUsers"
  | "authSessions";

/** The two collections that together say who is in a workspace. */
export type MemberRecordCollection = "workspaceMembers" | "authMembers";

/**
 * Filter values: equality, `null` (Mongo's "null or absent") and `$in` over
 * string ids. The same narrow set the account-deletion store models, so the
 * in-memory matcher can implement it exactly.
 */
export type RowFilterValue = string | null | { $in: string[] };
export type RowFilter = Readonly<Record<string, RowFilterValue>>;

export type StoredRow = Readonly<Record<string, unknown>>;

/** What `insertOne` throws when a unique index refused the row. */
export class DuplicateRowError extends Error {
  constructor(collection: MembershipCollection) {
    super(`membership: duplicate row in ${collection}`);
    this.name = "DuplicateRowError";
  }
}

/** Reading and updating the two membership records — all `ensureOwner` needs. */
export interface MemberRecordStore {
  find(collection: MemberRecordCollection, filter: RowFilter): Promise<StoredRow[]>;
  updateMany(
    collection: MemberRecordCollection,
    filter: RowFilter,
    set: Readonly<Record<string, unknown>>,
  ): Promise<number>;
}

export interface MembershipRowStore {
  find(collection: MembershipCollection, filter: RowFilter): Promise<StoredRow[]>;
  /** Returns the stored row, with its `id`. */
  insertOne(
    collection: MembershipCollection,
    row: Readonly<Record<string, unknown>>,
  ): Promise<StoredRow>;
  updateMany(
    collection: MembershipCollection,
    filter: RowFilter,
    set: Readonly<Record<string, unknown>>,
  ): Promise<number>;
  deleteMany(collection: MembershipCollection, filter: RowFilter): Promise<number>;
}

/**
 * A string id out of a stored value.
 *
 * better-auth's Mongo adapter hands ids back as strings, but a raw ObjectId
 * must still compare equal to the string ids the app collections store.
 */
export const asId = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && "toHexString" in value) {
    return String(value);
  }
  return null;
};

export const asDate = (value: unknown): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
};
