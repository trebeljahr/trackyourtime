// The workspaces a person is in, and which one their session defaults to.
import { permissionsFor, type WorkspaceSummary } from "@starter/shared";
import { membershipNotFound } from "./errors.js";
import { asRole } from "./records.js";
import { asDate, asId, type MembershipRowStore, type StoredRow } from "./store.js";

const oldestFirst = (a: StoredRow, b: StoredRow): number =>
  asDate(a.createdAt).getTime() - asDate(b.createdAt).getTime();

/**
 * Which of `memberships` a request that names no workspace runs in: the
 * session's active one while the person is still a member of it, else the
 * oldest. The same rule `resolveWorkspace` applies, stated once more here so
 * the switcher can mark it.
 */
export function defaultWorkspaceId(
  memberships: readonly { workspaceId: string }[],
  activeWorkspaceId: string | null,
): string | null {
  if (activeWorkspaceId && memberships.some((m) => m.workspaceId === activeWorkspaceId)) {
    return activeWorkspaceId;
  }
  return memberships[0]?.workspaceId ?? null;
}

/** Every workspace this person is in, oldest membership first. */
export async function listWorkspaces(
  store: MembershipRowStore,
  args: { userId: string; activeWorkspaceId: string | null },
): Promise<WorkspaceSummary[]> {
  const mine = (await store.find("workspaceMembers", { userId: args.userId })).sort(oldestFirst);
  const memberships = mine
    .map((row) => ({ row, workspaceId: asId(row.workspaceId) }))
    .filter((m): m is { row: StoredRow; workspaceId: string } => m.workspaceId !== null);
  if (memberships.length === 0) return [];

  const ids = memberships.map((m) => m.workspaceId);
  const [orgs, everyone] = await Promise.all([
    store.find("authOrganizations", { id: { $in: ids } }),
    store.find("workspaceMembers", { workspaceId: { $in: ids } }),
  ]);
  const nameOf = new Map<string, string>();
  for (const org of orgs) {
    const id = asId(org.id);
    if (id) nameOf.set(id, typeof org.name === "string" ? org.name : "");
  }
  const countOf = new Map<string, number>();
  for (const row of everyone) {
    const id = asId(row.workspaceId);
    if (id) countOf.set(id, (countOf.get(id) ?? 0) + 1);
  }
  const fallback = defaultWorkspaceId(memberships, args.activeWorkspaceId);

  return memberships.map(({ row, workspaceId }) => {
    const role = asRole(row.role);
    return {
      id: workspaceId,
      name: nameOf.get(workspaceId) ?? "",
      role,
      memberCount: countOf.get(workspaceId) ?? 1,
      isDefault: workspaceId === fallback,
      permissions: permissionsFor(role, {
        canViewOthersTime: row.canViewOthersTime === true,
        canViewOthersMoney: row.canViewOthersMoney === true,
      }),
    };
  });
}

/**
 * Point this session at a workspace the person is a member of.
 *
 * Writes the session row's `activeOrganizationId` — the field better-auth's
 * plugin used for the same purpose, so an existing session needs nothing
 * migrated. The cookie cache (five minutes, `auth/auth.ts`) can keep serving
 * the previous value to a cookie client for that long; that is acceptable
 * because the session default is only a default. First-party clients send an
 * explicit `workspaceId` on every call and never depend on this having landed.
 */
export async function setActiveWorkspace(
  store: MembershipRowStore,
  args: { userId: string; sessionId: string | null; workspaceId: string },
): Promise<{ workspaceId: string }> {
  const mine = await store.find("workspaceMembers", {
    workspaceId: args.workspaceId,
    userId: args.userId,
  });
  if (mine.length === 0) throw membershipNotFound();
  if (args.sessionId) {
    await store.updateMany(
      "authSessions",
      { id: args.sessionId, userId: args.userId },
      { activeOrganizationId: args.workspaceId },
    );
  }
  return { workspaceId: args.workspaceId };
}

/** A workspace's display name, or "" when it cannot be found. */
export async function workspaceName(
  store: MembershipRowStore,
  workspaceId: string,
): Promise<string> {
  const [org] = await store.find("authOrganizations", { id: workspaceId });
  return typeof org?.name === "string" ? org.name : "";
}
