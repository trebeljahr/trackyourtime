// The two membership records, read together and kept in step.
//
// A person is "in" a workspace in two places: better-auth's `member` row (the
// plugin's identity record) and the app's `WorkspaceMember` mirror (role,
// visibility flags, rate). The APP authorizes only from the mirror — the
// workspace middleware, API tokens, webhook deliveries and the sync fan-out
// all read `WorkspaceMember` — so the mirror is the one that grants access,
// and `member` is the one that locates the person for a retry.
//
// The two are written separately and can disagree after a crash between the
// writes. Everything here is written so that the disagreement is always the
// SAFE one: see the ordering notes on each operation in `lifecycle.ts`.
//
// Moved out of the account-deletion cascade, which still uses these exactly
// as before, so every lifecycle action shares one definition of "owner".
import type { WorkspaceRole } from "@starter/shared";
import {
  asDate,
  asId,
  type MemberRecordStore,
} from "./store.js";

/**
 * One membership, merged from the app mirror and better-auth's `member`. The
 * role is the higher of the two when they disagree.
 */
export type MemberRow = {
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
};

export type WorkspaceExit =
  | { kind: "delete-workspace"; workspaceId: string }
  | {
      kind: "leave-workspace";
      workspaceId: string;
      /** Who owns the workspace once this person is gone. */
      owner: string;
    };

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];
export const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };

/**
 * A stored role, read defensively.
 *
 * Only the three exact strings count. better-auth's plugin would read
 * "admin,owner" as both; here anything unrecognised is the LOWEST role, so a
 * value written around these rules can never widen what somebody may do.
 */
export const asRole = (value: unknown): WorkspaceRole =>
  ROLES.includes(value as WorkspaceRole) ? (value as WorkspaceRole) : "member";

/**
 * Both membership records for one workspace, merged per person.
 *
 * Reading both is what stops a person who exists in only one of them from
 * being missed — which, for account deletion, would turn "shared workspace"
 * into "delete it".
 */
export async function membersOf(
  store: MemberRecordStore,
  workspaceId: string,
): Promise<MemberRow[]> {
  const [app, auth] = await Promise.all([
    store.find("workspaceMembers", { workspaceId }),
    store.find("authMembers", { organizationId: workspaceId }),
  ]);
  const byUser = new Map<string, MemberRow>();
  for (const row of [...app, ...auth]) {
    const userId = asId(row.userId);
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
 *
 * The mirror is written FIRST: it is the record the app authorizes from, so a
 * crash after this write has already produced an owner, and the "never zero
 * owners" invariant holds at every step of a transfer.
 */
export async function ensureOwner(
  store: MemberRecordStore,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const [app, auth] = await Promise.all([
    store.find("workspaceMembers", { workspaceId, userId }),
    store.find("authMembers", { organizationId: workspaceId, userId }),
  ]);
  let changed = false;
  // An owner sees everyone's time and money — the flags are forced on for
  // every owner, a promoted one included.
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

/**
 * Who should own a workspace once `userId` is gone from it: an owner who is
 * already there, else the longest-standing admin, else the longest-standing
 * member. `null` when nobody else is left.
 */
export function chooseSuccessor(
  userId: string,
  members: readonly MemberRow[],
): string | null {
  const others = members.filter((member) => member.userId !== userId);
  if (others.length === 0) return null;
  const [owner] = [...others].sort(
    (a, b) =>
      ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.userId.localeCompare(b.userId),
  );
  return owner.userId;
}

/**
 * Decide what happens to one workspace when `userId` deletes their account.
 *
 * Alone in it: the workspace goes, with everything in it. Anybody else still
 * in it: only the departing person's own rows go, and the workspace stays.
 *
 * A shared workspace must never be left without an owner — nobody could then
 * manage members, rates or visibility. So the plan always names one (see
 * {@link chooseSuccessor}). Promotion rather than refusal, deliberately: a
 * deletion that other people's workspaces can block is not the in-app
 * deletion the store policies require, and the successor is the person who
 * would have been asked anyway. (Leaving, which is voluntary, refuses instead
 * — see `permissions.ts`.)
 *
 * Naming the owner even when nobody needs promoting is what makes a retry
 * safe: a run that promoted Bob in one membership record and crashed before
 * the other must, next time, finish promoting Bob rather than read him as
 * "already an owner" and stop.
 */
export function planWorkspaceExit(
  workspaceId: string,
  userId: string,
  members: readonly MemberRow[],
): WorkspaceExit {
  const owner = chooseSuccessor(userId, members);
  if (owner === null) return { kind: "delete-workspace", workspaceId };
  return { kind: "leave-workspace", workspaceId, owner };
}
