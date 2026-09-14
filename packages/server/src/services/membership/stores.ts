// The production row store behind every membership operation: the app's
// `WorkspaceMember` through mongoose, and better-auth's own tables through its
// adapter — never raw Mongo, because the adapter is what knows which fields it
// stored as ObjectIds.
import { isValidObjectId } from "mongoose";
import { getAuth } from "../../auth/auth.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { isDuplicateKeyError } from "../entries/errors.js";
import {
  DuplicateRowError,
  type MembershipCollection,
  type MembershipRowStore,
  type RowFilter,
  type StoredRow,
} from "./store.js";

type AdapterWhere = {
  field: string;
  value: string | string[] | null;
  operator?: "eq" | "in";
};

/** The slice of better-auth's `DBAdapter` this store uses. */
export type MembershipAuthAdapter = {
  findMany: (args: {
    model: string;
    where: AdapterWhere[];
    limit?: number;
  }) => Promise<unknown[]>;
  create: (args: {
    model: string;
    data: Record<string, unknown>;
    forceAllowId?: boolean;
  }) => Promise<unknown>;
  updateMany: (args: {
    model: string;
    where: AdapterWhere[];
    update: Record<string, unknown>;
  }) => Promise<number>;
  deleteMany: (args: { model: string; where: AdapterWhere[] }) => Promise<number>;
};

const AUTH_MODELS: Record<Exclude<MembershipCollection, "workspaceMembers">, string> = {
  authMembers: "member",
  authInvitations: "invitation",
  authOrganizations: "organization",
  authUsers: "user",
  authSessions: "session",
};

/**
 * An empty filter would match the whole collection — every workspace's
 * members — so it is refused rather than trusted never to be built.
 */
const requireFilter = (filter: RowFilter): void => {
  if (Object.keys(filter).length === 0) throw new Error("membership: empty filter");
};

const toWhere = (filter: RowFilter): AdapterWhere[] => {
  requireFilter(filter);
  return Object.entries(filter).map(([field, value]) => {
    if (value === null) throw new Error(`membership: null filter on auth field ${field}`);
    return typeof value === "string"
      ? { field, value }
      : { field, value: value.$in, operator: "in" };
  });
};

/**
 * `id` → `_id` for mongoose, or `null` when an id in the filter cannot be an
 * ObjectId at all — which then simply matches nothing, the same answer a
 * well-formed id from another workspace gets, instead of a CastError that
 * would answer 500 and tell the two apart.
 */
const toMongooseFilter = (filter: RowFilter): Record<string, unknown> | null => {
  requireFilter(filter);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filter)) {
    if (field === "id") {
      const ids = typeof value === "string" ? [value] : value === null ? [] : value.$in;
      if (!ids.every((id) => isValidObjectId(id))) return null;
      out._id = value;
    } else {
      out[field] = value;
    }
  }
  return out;
};

const workspaceMemberStore: MembershipRowStore = {
  async find(_collection, filter) {
    const query = toMongooseFilter(filter);
    if (!query) return [];
    const rows = (await WorkspaceMember.find(query).lean()) as unknown as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({ ...row, id: String(row._id) }));
  },
  async insertOne(collection, row) {
    try {
      const created = await WorkspaceMember.create({ ...row });
      const plain = created.toObject() as unknown as Record<string, unknown>;
      return { ...plain, id: String(plain._id) };
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new DuplicateRowError(collection);
      throw error;
    }
  },
  async updateMany(_collection, filter, set) {
    const query = toMongooseFilter(filter);
    if (!query) return 0;
    const result = await WorkspaceMember.updateMany(query, { $set: { ...set } });
    return result.matchedCount;
  },
  async deleteMany(_collection, filter) {
    const query = toMongooseFilter(filter);
    if (!query) return 0;
    const result = await WorkspaceMember.deleteMany(query);
    return result.deletedCount;
  },
};

/** better-auth's tables, through the adapter handed in. */
export function authMembershipStore(adapter: MembershipAuthAdapter): MembershipRowStore {
  const modelFor = (collection: MembershipCollection): string => {
    if (collection === "workspaceMembers") {
      throw new Error("membership: workspaceMembers is not an auth table");
    }
    return AUTH_MODELS[collection];
  };
  return {
    async find(collection, filter) {
      const rows = await adapter.findMany({
        model: modelFor(collection),
        where: toWhere(filter),
        limit: 10_000,
      });
      return rows as StoredRow[];
    },
    async insertOne(collection, row) {
      // An explicit id is kept (`forceAllowId`): invitation ids are generated
      // from a CSPRNG in `invitations.ts`, because the adapter's own ObjectIds
      // are timestamp-plus-counter and guessable from any id this process has
      // handed out — and possession of an invitation id is the proof of
      // having received it.
      const created = await adapter.create({
        model: modelFor(collection),
        data: { ...row },
        forceAllowId: typeof row.id === "string",
      });
      return created as StoredRow;
    },
    async updateMany(collection, filter, set) {
      return adapter.updateMany({
        model: modelFor(collection),
        where: toWhere(filter),
        update: { ...set },
      });
    },
    async deleteMany(collection, filter) {
      return adapter.deleteMany({ model: modelFor(collection), where: toWhere(filter) });
    },
  };
}

/** Route each collection to the store that owns it. */
export function routedMembershipStore(
  app: MembershipRowStore,
  auth: MembershipRowStore,
): MembershipRowStore {
  const pick = (collection: MembershipCollection): MembershipRowStore =>
    collection === "workspaceMembers" ? app : auth;
  return {
    find: (collection, filter) => pick(collection).find(collection, filter),
    insertOne: (collection, row) => pick(collection).insertOne(collection, row),
    updateMany: (collection, filter, set) =>
      pick(collection).updateMany(collection, filter, set),
    deleteMany: (collection, filter) => pick(collection).deleteMany(collection, filter),
  };
}

/**
 * The live store. Resolved per call because better-auth's context is created
 * after the database connects, and a module-level store would capture nothing.
 */
export async function productionMembershipStore(): Promise<MembershipRowStore> {
  const context = (await getAuth().$context) as { adapter: MembershipAuthAdapter };
  return routedMembershipStore(workspaceMemberStore, authMembershipStore(context.adapter));
}
