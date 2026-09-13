// Running the account-deletion plan against a row store.
//
// The store is injected, and deliberately dumb — find, update, delete by
// filter — so the whole orchestration (which workspaces, who is promoted, in
// what order, and what a retry after a crash does) runs in the unit suite
// against in-memory rows. The two real stores are thin: mongoose for app
// collections, better-auth's adapter for its own tables.
import type { WorkspaceRole } from "@starter/shared";
import {
  memberDepartureSteps,
  planWorkspaceExit,
  userScopedSteps,
  workspaceDeletionSteps,
  type DeletionCollection,
  type DeletionFilter,
  type MemberRow,
} from "./plan.js";

export type StoredRow = Readonly<Record<string, unknown>>;

export interface DeletionRowStore {
  find(collection: DeletionCollection, filter: DeletionFilter): Promise<StoredRow[]>;
  updateMany(
    collection: DeletionCollection,
    filter: DeletionFilter,
    set: Readonly<Record<string, unknown>>,
  ): Promise<number>;
  deleteMany(collection: DeletionCollection, filter: DeletionFilter): Promise<number>;
}

export type AccountDeletionReport = {
  workspacesDeleted: string[];
  workspacesLeft: string[];
  /** workspaceId → the member promoted to owner there. */
  promoted: Record<string, string>;
};

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];
const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };

const asString = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value;
  // better-auth's Mongo adapter hands ids back as strings, but a raw ObjectId
  // must still compare equal to the string ids the app collections store.
  if (value !== null && typeof value === "object" && "toHexString" in value) {
    return String(value);
  }
  return null;
};

const asRole = (value: unknown): WorkspaceRole =>
  ROLES.includes(value as WorkspaceRole) ? (value as WorkspaceRole) : "member";

const asDate = (value: unknown): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
};

/**
 * Both membership records for one workspace, merged per person.
 *
 * The app mirror (`WorkspaceMember`) and better-auth's `member` are written
 * separately and can disagree after a crash between the two writes. Reading
 * both is what stops a person who exists in only one of them from being
 * missed — which would turn "shared workspace" into "delete it".
 */
async function membersOf(
  store: DeletionRowStore,
  workspaceId: string,
): Promise<MemberRow[]> {
  const [app, auth] = await Promise.all([
    store.find("workspaceMembers", { workspaceId }),
    store.find("authMembers", { organizationId: workspaceId }),
  ]);
  const byUser = new Map<string, MemberRow>();
  for (const row of [...app, ...auth]) {
    const userId = asString(row.userId);
    if (!userId) continue;
    const role = asRole(row.role);
    const createdAt = asDate(row.createdAt);
    const seen = byUser.get(userId);
    byUser.set(userId, {
      userId,
      role: seen && ROLE_RANK[seen.role] <= ROLE_RANK[role] ? seen.role : role,
      createdAt: seen && seen.createdAt <= createdAt ? seen.createdAt : createdAt,
    });
  }
  return [...byUser.values()];
}

/**
 * Make `userId` an owner in whichever membership records do not already say
 * so. Returns whether anything changed — a promotion, or the second half of
 * one an earlier run did not finish.
 */
async function ensureOwner(
  store: DeletionRowStore,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const [app, auth] = await Promise.all([
    store.find("workspaceMembers", { workspaceId, userId }),
    store.find("authMembers", { organizationId: workspaceId, userId }),
  ]);
  let changed = false;
  // An owner sees everyone's time and money: `upsertWorkspaceMember` grants
  // both to every owner, and a promoted one is no different.
  if (
    app.some(
      (row) =>
        row.role !== "owner" ||
        row.canViewOthersTime !== true ||
        row.canViewOthersMoney !== true,
    )
  ) {
    await store.updateMany(
      "workspaceMembers",
      { workspaceId, userId },
      { role: "owner", canViewOthersTime: true, canViewOthersMoney: true },
    );
    changed = true;
  }
  if (auth.some((row) => row.role !== "owner")) {
    await store.updateMany(
      "authMembers",
      { organizationId: workspaceId, userId },
      { role: "owner" },
    );
    changed = true;
  }
  return changed;
}

async function workspaceIdsOf(
  store: DeletionRowStore,
  userId: string,
): Promise<string[]> {
  const [app, auth] = await Promise.all([
    store.find("workspaceMembers", { userId }),
    store.find("authMembers", { userId }),
  ]);
  const ids = new Set<string>();
  for (const row of app) {
    const id = asString(row.workspaceId);
    if (id) ids.add(id);
  }
  for (const row of auth) {
    const id = asString(row.organizationId);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Delete everything `user` owns, leaving shared workspaces intact.
 *
 * Idempotent: every step is a delete or an update by filter, and the rows that
 * locate a workspace are the last ones removed from it. A run that throws
 * part-way leaves a state the next run finishes from, so the caller retries by
 * calling this again — there is no progress marker to get out of sync.
 */
export async function deleteAccountData(
  store: DeletionRowStore,
  user: { id: string; email?: string | null },
): Promise<AccountDeletionReport> {
  const report: AccountDeletionReport = {
    workspacesDeleted: [],
    workspacesLeft: [],
    promoted: {},
  };

  for (const workspaceId of await workspaceIdsOf(store, user.id)) {
    const exit = planWorkspaceExit(
      workspaceId,
      user.id,
      await membersOf(store, workspaceId),
    );

    if (exit.kind === "delete-workspace") {
      for (const step of workspaceDeletionSteps(workspaceId)) {
        await store.deleteMany(step.collection, step.filter);
      }
      report.workspacesDeleted.push(workspaceId);
      continue;
    }

    // Promote before removing anybody: a crash in between must leave a
    // workspace with two owners, never one with none.
    if (await ensureOwner(store, workspaceId, exit.owner)) {
      report.promoted[workspaceId] = exit.owner;
    }

    const webhookIds = (
      await store.find("webhookSubscriptions", { workspaceId, createdBy: user.id })
    )
      .map((row) => asString(row.id))
      .filter((id): id is string => id !== null);

    for (const step of memberDepartureSteps(workspaceId, user.id, webhookIds)) {
      await store.deleteMany(step.collection, step.filter);
    }
    report.workspacesLeft.push(workspaceId);
  }

  for (const step of userScopedSteps(user)) {
    await store.deleteMany(step.collection, step.filter);
  }

  return report;
}
