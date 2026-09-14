// Member management: list, change role, change visibility, remove, leave,
// transfer ownership.
//
// Each action runs the same four steps, in this order, and the order is the
// security property:
//
//   1. find the target INSIDE the caller's workspace — anything else is
//      NOT_FOUND, before any permission is consulted, so a refusal can never
//      confirm that a foreign member id exists;
//   2. ask `permissions.ts`, which answers a stable FORBIDDEN code;
//   3. write both records through `lifecycle.ts`;
//   4. publish `membership.changed`.
//
// The tRPC routers are one line over these. There is no other way to change a
// membership: better-auth's own `/organization/*` endpoints answer 404 over
// HTTP (see `organization-lockdown.ts`).
import type {
  SyncEvent,
  WorkspaceMemberRow,
  WorkspaceRole,
} from "@starter/shared";
import { assertAllowed, membershipNotFound } from "./errors.js";
import {
  removeMembership,
  setRole,
  setVisibility,
  transferOwnership as transferOwnershipRecords,
} from "./lifecycle.js";
import {
  refuseLeave,
  refuseRemoval,
  refuseRoleChange,
  refuseTransfer,
  refuseVisibilityChange,
  type MembershipActor,
} from "./permissions.js";
import { ROLE_RANK, asRole } from "./records.js";
import { asDate, asId, type MembershipRowStore, type StoredRow } from "./store.js";

/** Everything a membership action does besides writing rows. */
export type MembershipEffects = {
  now: () => Date;
  /**
   * Stop this person's running entry in this workspace, if any, and publish
   * `timer.stopped`. Only in THIS workspace: a timer they run elsewhere is
   * none of this workspace's business.
   */
  stopRunningEntry: (userId: string, workspaceId: string) => Promise<void>;
  publishWorkspace: (workspaceId: string, event: SyncEvent) => void;
  publishUser: (userId: string, event: SyncEvent) => void;
  /** The person's oldest remaining workspace, creating a personal one if none. */
  defaultWorkspaceFor: (user: WorkspaceUser) => Promise<string | null>;
};

export type MembershipDeps = { store: MembershipRowStore } & MembershipEffects;

export type WorkspaceUser = { id: string; name?: string | null; email?: string | null };

/** The caller, as the workspace middleware resolved them. */
export type WorkspaceActor = MembershipActor & { workspaceId: string };

type Target = {
  memberId: string;
  userId: string;
  role: WorkspaceRole;
  /**
   * Whether the person still has a `WorkspaceMember` row. False only for a
   * removal a crash cut in half: a `member` row with no mirror, which the app
   * already reads as "not in the workspace".
   */
  hasAccess: boolean;
};

const changed = (
  workspaceId: string,
  reason: Extract<SyncEvent, { kind: "membership.changed" }>["reason"],
): SyncEvent => ({ kind: "membership.changed", workspaceId, reason });

/**
 * Find a member of THIS workspace by `memberId`.
 *
 * `memberId` is better-auth's `member` row id — the record that survives a
 * half-finished removal, so retrying one finds the person again — falling back
 * to the mirror's id for a membership whose `member` row is missing. Both
 * lookups carry the workspace id, so an id from another workspace matches
 * nothing and answers exactly what a made-up one does.
 */
async function findTarget(
  store: MembershipRowStore,
  workspaceId: string,
  memberId: string,
): Promise<Target> {
  const [auth] = await store.find("authMembers", {
    id: memberId,
    organizationId: workspaceId,
  });
  const fallback = auth
    ? null
    : (await store.find("workspaceMembers", { id: memberId, workspaceId }))[0];
  const userId = asId((auth ?? fallback)?.userId);
  if (!userId) throw membershipNotFound();

  // The role the APP acts on is the mirror's; `member` answers only when the
  // mirror is already gone (a removal being retried).
  const [app] = await store.find("workspaceMembers", { workspaceId, userId });
  return { memberId, userId, role: asRole((app ?? auth)?.role), hasAccess: app !== undefined };
}

/**
 * {@link findTarget}, for an action that only makes sense on somebody who is
 * really in the workspace. A half-removed person answers NOT_FOUND — the same
 * as anybody else the app does not consider a member.
 *
 * Only `remove` may act on a half-removed person, because finishing that
 * removal is exactly what it is for. Transferring ownership to one would
 * promote a `member` row nobody authorizes from and then demote the only
 * real owner: a workspace with no owner at all.
 */
async function findMember(
  store: MembershipRowStore,
  workspaceId: string,
  memberId: string,
): Promise<Target> {
  const target = await findTarget(store, workspaceId, memberId);
  if (!target.hasAccess) throw membershipNotFound();
  return target;
}

async function mirrorRows(
  store: MembershipRowStore,
  workspaceId: string,
): Promise<StoredRow[]> {
  return store.find("workspaceMembers", { workspaceId });
}

const ownersIn = (rows: readonly StoredRow[]): number =>
  rows.filter((row) => row.role === "owner").length;

/**
 * Wire rows for a workspace, or for one person in it.
 *
 * Built from the mirror — a person with only a `member` row has no access and
 * is not listed — with the `member` id as `memberId` and the email and name
 * read from better-auth's user.
 */
async function buildRows(
  store: MembershipRowStore,
  workspaceId: string,
  selfId: string,
  onlyUserId?: string,
): Promise<WorkspaceMemberRow[]> {
  const mirror = onlyUserId
    ? await store.find("workspaceMembers", { workspaceId, userId: onlyUserId })
    : await mirrorRows(store, workspaceId);
  if (mirror.length === 0) return [];
  const userIds = mirror.map((row) => asId(row.userId)).filter((id): id is string => !!id);
  const [auth, users] = await Promise.all([
    store.find("authMembers", { organizationId: workspaceId, userId: { $in: userIds } }),
    store.find("authUsers", { id: { $in: userIds } }),
  ]);
  const memberIdOf = new Map<string, string>();
  for (const row of auth) {
    const userId = asId(row.userId);
    const id = asId(row.id);
    if (userId && id && !memberIdOf.has(userId)) memberIdOf.set(userId, id);
  }
  const userOf = new Map<string, StoredRow>();
  for (const row of users) {
    const id = asId(row.id);
    if (id) userOf.set(id, row);
  }

  return mirror
    .map((row): WorkspaceMemberRow | null => {
      const userId = asId(row.userId);
      if (!userId) return null;
      const user = userOf.get(userId);
      const role = asRole(row.role);
      const owner = role === "owner";
      const name =
        (typeof user?.name === "string" && user.name.trim()) ||
        (typeof row.name === "string" && row.name.trim()) ||
        "";
      return {
        memberId: memberIdOf.get(userId) ?? asId(row.id) ?? userId,
        userId,
        name,
        email: typeof user?.email === "string" ? user.email : "",
        role,
        canViewOthersTime: owner || row.canViewOthersTime === true,
        canViewOthersMoney: owner || row.canViewOthersMoney === true,
        joinedAt: asDate(row.createdAt).toISOString(),
        isSelf: userId === selfId,
      };
    })
    .filter((row): row is WorkspaceMemberRow => row !== null)
    .sort(
      (a, b) =>
        ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
        a.joinedAt.localeCompare(b.joinedAt) ||
        a.userId.localeCompare(b.userId),
    );
}

async function rowFor(
  store: MembershipRowStore,
  workspaceId: string,
  userId: string,
  selfId: string,
): Promise<WorkspaceMemberRow> {
  const [row] = await buildRows(store, workspaceId, selfId, userId);
  if (!row) throw membershipNotFound();
  return row;
}

/** Everybody in the workspace. Every member may read it. */
export async function listMembers(
  deps: Pick<MembershipDeps, "store">,
  actor: WorkspaceActor,
): Promise<WorkspaceMemberRow[]> {
  return buildRows(deps.store, actor.workspaceId, actor.userId);
}

export async function updateMemberRole(
  deps: MembershipDeps,
  actor: WorkspaceActor,
  input: { memberId: string; role: WorkspaceRole },
): Promise<WorkspaceMemberRow> {
  const target = await findMember(deps.store, actor.workspaceId, input.memberId);
  const owners = ownersIn(await mirrorRows(deps.store, actor.workspaceId));
  assertAllowed(refuseRoleChange(actor, target, input.role, owners));

  await setRole(deps.store, {
    workspaceId: actor.workspaceId,
    userId: target.userId,
    role: input.role,
  });
  deps.publishWorkspace(actor.workspaceId, changed(actor.workspaceId, "role"));
  return rowFor(deps.store, actor.workspaceId, target.userId, actor.userId);
}

export async function updateMemberVisibility(
  deps: MembershipDeps,
  actor: WorkspaceActor,
  input: { memberId: string; canViewOthersTime?: boolean; canViewOthersMoney?: boolean },
): Promise<WorkspaceMemberRow> {
  const target = await findMember(deps.store, actor.workspaceId, input.memberId);
  const patch = {
    ...(input.canViewOthersTime !== undefined
      ? { canViewOthersTime: input.canViewOthersTime }
      : {}),
    ...(input.canViewOthersMoney !== undefined
      ? { canViewOthersMoney: input.canViewOthersMoney }
      : {}),
  };
  assertAllowed(refuseVisibilityChange(actor, target, patch));

  await setVisibility(deps.store, {
    workspaceId: actor.workspaceId,
    userId: target.userId,
    ...patch,
  });
  deps.publishWorkspace(actor.workspaceId, changed(actor.workspaceId, "visibility"));
  // The person whose view changed has to refetch too, and they are in the
  // workspace fan-out already — no separate publish needed.
  return rowFor(deps.store, actor.workspaceId, target.userId, actor.userId);
}

export async function removeMember(
  deps: MembershipDeps,
  actor: WorkspaceActor,
  input: { memberId: string },
): Promise<{ ok: true }> {
  const target = await findTarget(deps.store, actor.workspaceId, input.memberId);
  const owners = ownersIn(await mirrorRows(deps.store, actor.workspaceId));
  assertAllowed(refuseRemoval(actor, target, owners));

  await removeMembership(deps.store, {
    workspaceId: actor.workspaceId,
    userId: target.userId,
    stopRunningEntry: deps.stopRunningEntry,
  });
  const event = changed(actor.workspaceId, "removed");
  deps.publishWorkspace(actor.workspaceId, event);
  // No longer a member, so the workspace fan-out skips them — tell their
  // devices directly, or they keep showing a workspace they cannot reach.
  deps.publishUser(target.userId, event);
  return { ok: true };
}

/**
 * Leave the workspace. Returns where the caller lands: their oldest remaining
 * workspace, or a fresh personal one if this was their last.
 */
export async function leaveWorkspace(
  deps: MembershipDeps,
  actor: WorkspaceActor & {
    user: WorkspaceUser;
    sessionId: string | null;
    activeWorkspaceId: string | null;
  },
): Promise<{ nextWorkspaceId: string }> {
  const mirror = await mirrorRows(deps.store, actor.workspaceId);
  const others = mirror.filter((row) => asId(row.userId) !== actor.userId).length;
  assertAllowed(refuseLeave(actor, others, ownersIn(mirror)));

  await removeMembership(deps.store, {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    stopRunningEntry: deps.stopRunningEntry,
  });

  const remaining = (await deps.store.find("workspaceMembers", { userId: actor.userId }))
    .filter((row) => asId(row.workspaceId) !== actor.workspaceId)
    .sort((a, b) => asDate(a.createdAt).getTime() - asDate(b.createdAt).getTime());
  const nextWorkspaceId =
    asId(remaining[0]?.workspaceId) ?? (await deps.defaultWorkspaceFor(actor.user));
  if (!nextWorkspaceId) throw membershipNotFound();

  // Only move the session if it was pointed at the workspace just left; a
  // session pointed somewhere else is still pointed somewhere valid.
  if (actor.sessionId && actor.activeWorkspaceId === actor.workspaceId) {
    await deps.store.updateMany(
      "authSessions",
      { id: actor.sessionId, userId: actor.userId },
      { activeOrganizationId: nextWorkspaceId },
    );
  }

  const event = changed(actor.workspaceId, "left");
  deps.publishWorkspace(actor.workspaceId, event);
  deps.publishUser(actor.userId, event);
  return { nextWorkspaceId };
}

export async function transferOwnership(
  deps: MembershipDeps,
  actor: WorkspaceActor,
  input: { memberId: string },
): Promise<{ ok: true }> {
  const target = await findMember(deps.store, actor.workspaceId, input.memberId);
  assertAllowed(refuseTransfer(actor, target));

  await transferOwnershipRecords(deps.store, {
    workspaceId: actor.workspaceId,
    fromUserId: actor.userId,
    toUserId: target.userId,
  });
  deps.publishWorkspace(actor.workspaceId, changed(actor.workspaceId, "transferred"));
  return { ok: true };
}
