// Running the account-deletion plan against a row store.
//
// The store is injected, and deliberately dumb — find, update, delete by
// filter — so the whole orchestration (which workspaces, who is promoted, in
// what order, and what a retry after a crash does) runs in the unit suite
// against in-memory rows. The two real stores are thin: mongoose for app
// collections, better-auth's adapter for its own tables.
import {
  memberDepartureSteps,
  userScopedSteps,
  workspaceDeletionSteps,
  type DeletionCollection,
  type DeletionFilter,
} from "./plan.js";
import {
  ensureOwner,
  membersOf,
  planWorkspaceExit,
} from "../membership/records.js";
import { asId } from "../membership/store.js";

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

// `membersOf`, `ensureOwner` and `planWorkspaceExit` live in
// services/membership/records.ts, shared with every other membership action
// (leave, remove, transfer), so "who owns this workspace" has one definition.

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
    const id = asId(row.workspaceId);
    if (id) ids.add(id);
  }
  for (const row of auth) {
    const id = asId(row.organizationId);
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
      .map((row) => asId(row.id))
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
