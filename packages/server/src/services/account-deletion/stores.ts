// The two real row stores behind `deleteAccountData`.
import type { Model } from "mongoose";
import { ApiToken } from "../../models/ApiToken.js";
import { BusinessProfileModel } from "../../models/BusinessProfile.js";
import { Client } from "../../models/Client.js";
import { Favorite } from "../../models/Favorite.js";
import { ImportBatch } from "../../models/ImportBatch.js";
import { Invoice } from "../../models/Invoice.js";
import { Profile } from "../../models/Profile.js";
import { Project } from "../../models/Project.js";
import {
  UserPreferencesModel,
  WorkspaceSettingsModel,
} from "../../models/Settings.js";
import { Tag } from "../../models/Tag.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { WebhookDelivery } from "../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import type { DeletionRowStore, StoredRow } from "./delete-account.js";
import {
  AUTH_COLLECTIONS,
  type DeletionCollection,
  type DeletionFilter,
} from "./plan.js";

type AppCollection = Exclude<
  DeletionCollection,
  "authOrganizations" | "authMembers" | "authInvitations" | "authDeviceCodes"
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const APP_MODELS: Record<AppCollection, Model<any>> = {
  timeEntries: TimeEntry,
  clients: Client,
  projects: Project,
  tasks: Task,
  tags: Tag,
  favorites: Favorite,
  invoices: Invoice,
  importBatches: ImportBatch,
  apiTokens: ApiToken,
  webhookSubscriptions: WebhookSubscription,
  webhookDeliveries: WebhookDelivery,
  workspaceSettings: WorkspaceSettingsModel,
  businessProfiles: BusinessProfileModel,
  workspaceMembers: WorkspaceMember,
  userPreferences: UserPreferencesModel,
  profiles: Profile,
};

/** better-auth model names for its own tables. */
const AUTH_MODELS: Record<string, string> = {
  authOrganizations: "organization",
  authMembers: "member",
  authInvitations: "invitation",
  authDeviceCodes: "deviceCode",
};

/**
 * An empty filter would match the whole collection — every user's data — so
 * it is refused here rather than trusted to never be built.
 */
const appModel = (
  collection: DeletionCollection,
  filter: DeletionFilter,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Model<any> => {
  if (AUTH_COLLECTIONS.has(collection)) {
    throw new Error(`account deletion: ${collection} is an auth table`);
  }
  if (Object.keys(filter).length === 0) {
    throw new Error("account deletion: empty filter");
  }
  return APP_MODELS[collection as AppCollection];
};

/** App-owned collections, through mongoose. `_id` is surfaced as `id`. */
export const mongooseRowStore: DeletionRowStore = {
  async find(collection, filter) {
    const model = appModel(collection, filter);
    const rows: Array<Record<string, unknown>> = await model.find(filter).lean();
    return rows.map((row) => ({ ...row, id: String(row._id) }));
  },
  async updateMany(collection, filter, set) {
    const model = appModel(collection, filter);
    const result = await model.updateMany(filter, { $set: set });
    return result.modifiedCount;
  },
  async deleteMany(collection, filter) {
    const model = appModel(collection, filter);
    const result = await model.deleteMany(filter);
    return result.deletedCount;
  },
};

type AdapterWhere = {
  field: string;
  value: string | string[] | null;
  operator?: "eq" | "in";
};

/** The slice of better-auth's `DBAdapter` this store uses. */
export type AuthAdapterLike = {
  findMany: (args: {
    model: string;
    where: AdapterWhere[];
    limit?: number;
  }) => Promise<unknown[]>;
  updateMany: (args: {
    model: string;
    where: AdapterWhere[];
    update: Record<string, unknown>;
  }) => Promise<number>;
  deleteMany: (args: { model: string; where: AdapterWhere[] }) => Promise<number>;
};

const toWhere = (filter: DeletionFilter): AdapterWhere[] =>
  Object.entries(filter).map(([field, value]) => {
    if (value === null) {
      throw new Error(`account deletion: null filter on auth field ${field}`);
    }
    return typeof value === "string"
      ? { field, value }
      : { field, value: value.$in, operator: "in" };
  });

/**
 * better-auth's tables, through its own adapter — never raw Mongo, because the
 * adapter is what knows which fields it stored as ObjectIds.
 *
 * An empty where clause is refused for the same reason as above.
 */
export function authRowStore(adapter: AuthAdapterLike): DeletionRowStore {
  const modelFor = (collection: DeletionCollection): string => {
    const model = AUTH_MODELS[collection];
    if (!model) throw new Error(`account deletion: ${collection} is not an auth table`);
    return model;
  };
  const whereFor = (filter: DeletionFilter): AdapterWhere[] => {
    const where = toWhere(filter);
    if (where.length === 0) throw new Error("account deletion: empty filter");
    return where;
  };
  return {
    async find(collection, filter) {
      const rows = await adapter.findMany({
        model: modelFor(collection),
        where: whereFor(filter),
        limit: 10_000,
      });
      return rows as StoredRow[];
    },
    async updateMany(collection, filter, set) {
      return adapter.updateMany({
        model: modelFor(collection),
        where: whereFor(filter),
        update: { ...set },
      });
    },
    async deleteMany(collection, filter) {
      return adapter.deleteMany({
        model: modelFor(collection),
        where: whereFor(filter),
      });
    },
  };
}

/** Route each collection to the store that owns it. */
export function routedRowStore(
  app: DeletionRowStore,
  auth: DeletionRowStore,
): DeletionRowStore {
  const pick = (collection: DeletionCollection): DeletionRowStore =>
    AUTH_COLLECTIONS.has(collection) ? auth : app;
  return {
    find: (collection, filter) => pick(collection).find(collection, filter),
    updateMany: (collection, filter, set) =>
      pick(collection).updateMany(collection, filter, set),
    deleteMany: (collection, filter) =>
      pick(collection).deleteMany(collection, filter),
  };
}
