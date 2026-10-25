import { PRIVATE_USER_ONLY_KINDS } from "@starter/shared";
import { withPrivateWorkspaceErasure } from "../privacy/plaintext-guard.js";
// The two real row stores behind `deleteAccountData`.
import { PrivateAccount, PrivateDirectory, PrivateDeviceRequest, PrivateSourceChallengeRequest, PrivateMigrationReceipt, PrivateRecord, PrivateSnapshotChunk, PrivateSnapshotReader, PrivateProjectionRoot, PrivateProjectionReader, PrivateWorkspace, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import type { Model } from "mongoose";
import { withStorageOwnershipAdoption } from "../storage-quota.js";
import { fenceWorkspace, withBusinessTransaction } from "../business-transaction.js";
import { StorageUsage, StorageFence } from "../../models/StorageUsage.js";
import { ImportLease } from "../../models/ImportBudget.js";
import { ApiToken } from "../../models/ApiToken.js";
import { Avatar } from "../../models/Avatar.js";
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
import { TimesheetApproval, TimesheetPolicy, WorkspaceWriteFence } from "../../models/TimesheetApproval.js";
import { EntryOperation } from "../../models/EntryOperation.js";
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
  | "authOrganizations"
  | "authMembers"
  | "authInvitations"
  | "authDeviceCodes"
  | "authPasskeys"
  | "authTwoFactors"
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const APP_MODELS: Record<AppCollection, Model<any, {}, {}, any>> = {
  privateAccounts: PrivateAccount,
  privateDirectories: PrivateDirectory,
  privateSnapshotChunks: PrivateSnapshotChunk,
  privateSnapshotReaders: PrivateSnapshotReader,
  privateProjectionRoots: PrivateProjectionRoot,
  privateProjectionReaders: PrivateProjectionReader,
  privateMigrationReceipts: PrivateMigrationReceipt,
  privateDeviceRequests: PrivateDeviceRequest,
  privateSourceChallenges: PrivateSourceChallengeRequest,
  privateRecords: PrivateRecord,
  privateWorkspaceCommits: PrivateWorkspaceCommit,
  privateWorkspaces: PrivateWorkspace,
  timeEntries: TimeEntry,
  entryOperations: EntryOperation,
  storageUsage: StorageUsage,
  storageFences: StorageFence,
  importLeases: ImportLease,
  timesheetApprovals: TimesheetApproval,
  timesheetPolicies: TimesheetPolicy,
  workspaceWriteFences: WorkspaceWriteFence,
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
  avatars: Avatar,
};

/** better-auth model names for its own tables. */
const AUTH_MODELS: Record<string, string> = {
  authOrganizations: "organization",
  authMembers: "member",
  authInvitations: "invitation",
  authDeviceCodes: "deviceCode",
  authTwoFactors: "twoFactor",
  authPasskeys: "passkey",
};

/**
 * An empty filter would match the whole collection — every user's data — so
 * it is refused here rather than trusted to never be built.
 */
const appModel = (
  collection: DeletionCollection,
  filter: DeletionFilter,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Model<any, {}, {}, any> => {
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
  async erasePrivateUserData(userId) {
    if (!userId) throw new Error("account deletion: empty user ID");
    const workspaces = new Set([
      ...await PrivateRecord.distinct("workspaceId", { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId }),
      ...await PrivateSnapshotChunk.distinct("workspaceId", { records: { $elemMatch: { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId } } }),
      ...await PrivateSnapshotReader.distinct("workspaceId", { userId }),
      ...await PrivateProjectionReader.distinct("workspaceId", { userId }),
      ...await PrivateWorkspaceCommit.distinct("workspaceId", { $or: [
        { records: { $elemMatch: { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId } } },
        { "readerSignatures.userId": userId },
      ] }),
    ]);
    for (const workspaceId of [...workspaces].sort()) {
      await withBusinessTransaction(async () => {
        await fenceWorkspace(workspaceId);
        await PrivateRecord.deleteMany({ workspaceId, kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId });
        await PrivateSnapshotChunk.updateMany({ workspaceId }, { $pull: { records: { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId } } });
        await PrivateSnapshotReader.deleteMany({ workspaceId, userId });
        await PrivateProjectionReader.deleteMany({ workspaceId, userId });
        // Never delete a whole mixed commit: others still need its shared
        // ciphertext. Their separately signed projections excluded these
        // personal records from the start. Keep immutable manifest commitments and
        // historical public keys/recipient grants for signature verification.
        await PrivateWorkspaceCommit.updateMany({ workspaceId }, { $pull: {
          records: { kind: { $in: [...PRIVATE_USER_ONLY_KINDS] }, authorId: userId },
          readerSignatures: { userId },
        } });
      });
    }
  },
  async find(collection, filter) {
    const model = appModel(collection, filter);
    const rows: Array<Record<string, unknown>> = await model.find(filter).lean();
    return rows.map((row) => ({ ...row, id: String(row._id) }));
  },
  async updateMany(collection, filter, set) {
    const model = appModel(collection, filter);
    const write = async () => {
      const workspaces = typeof filter.workspaceId === "string" ? [filter.workspaceId] : await model.distinct("workspaceId", filter);
      return withPrivateWorkspaceErasure(workspaces, async () => await model.updateMany(filter, { $set: set }));
    };
    const result = collection === "workspaceMembers" && set.role === "owner"
      ? await withStorageOwnershipAdoption(write) : await write();
    return result.modifiedCount;
  },
  async deleteMany(collection, filter) {
    const model = appModel(collection, filter);
    return withBusinessTransaction(async () => {
      const workspaces = typeof filter.workspaceId === "string" ? [filter.workspaceId] : await model.distinct("workspaceId", filter);
      const result = await withPrivateWorkspaceErasure(workspaces, async () => await model.deleteMany(filter));
      // Removing the final mirror row also removes the locator needed to
      // retry account erasure. Clean any ledger re-seeded by that last guarded
      // write in the same transaction, before that locator can disappear.
      if (collection === "workspaceMembers" && typeof filter.workspaceId === "string" && !await WorkspaceMember.exists({ workspaceId: filter.workspaceId })) {
        await StorageUsage.deleteOne({ _id: filter.workspaceId });
        await StorageFence.deleteOne({ _id: `workspace:${filter.workspaceId}` });
        await ImportLease.deleteOne({ _id: JSON.stringify(["workspace", filter.workspaceId]) });
      }
      return result.deletedCount;
    });
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
    async erasePrivateUserData() { throw new Error("account deletion: private data is not an auth table"); },
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
    erasePrivateUserData: (userId) => app.erasePrivateUserData(userId),
    find: (collection, filter) => pick(collection).find(collection, filter),
    updateMany: (collection, filter, set) =>
      pick(collection).updateMany(collection, filter, set),
    deleteMany: (collection, filter) =>
      pick(collection).deleteMany(collection, filter),
  };
}
