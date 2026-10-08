// The workspaces a person is in, and which one their session defaults to.
import {
  asWorkspaceKind,
  permissionsFor,
  WORKSPACE_NAME_MAX,
  type SyncEvent,
  type WorkspaceKind,
  type WorkspaceSummary,
} from "@starter/shared";
import { membershipNotFound, membershipRefused } from "./errors.js";
import { initialFlags } from "./lifecycle.js";
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
  const kindOf = new Map<string, WorkspaceKind>();
  for (const org of orgs) {
    const id = asId(org.id);
    if (!id) continue;
    nameOf.set(id, typeof org.name === "string" ? org.name : "");
    kindOf.set(id, asWorkspaceKind(org.kind));
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
      kind: kindOf.get(workspaceId) ?? "team",
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

/**
 * Whether a workspace is somebody's personal one. Read from the organization
 * row, where the kind is written in the same insert that creates the
 * workspace; a row without one (or none at all) is a team workspace.
 */
export async function workspaceKind(
  store: Pick<MembershipRowStore, "find">,
  workspaceId: string,
): Promise<WorkspaceKind> {
  const [org] = await store.find("authOrganizations", { id: workspaceId });
  return asWorkspaceKind(org?.kind);
}

/**
 * How many workspaces one person may own at once, personal included. Generous
 * for any real team setup; it exists so a script cannot mint organizations
 * without bound.
 */
export const MAX_OWNED_WORKSPACES = 25;

const SLUG_MAX = 48;

/** A slug from the name with a random tail, since slugs are global. */
export function teamWorkspaceSlug(name: string, tail: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const head = (base || "workspace").slice(0, SLUG_MAX - tail.length - 1).replace(/-+$/, "");
  return `${head || "workspace"}-${tail}`;
}

export type WorkspaceCreationDeps = {
  store: MembershipRowStore;
  now: () => Date;
  /** Random hex for the slug tail. */
  slugTail: () => string;
  /** Seed the new workspace's currency and week start. Idempotent. */
  seedSettings: (
    workspaceId: string,
    settings: { currency: string; weekStartsOn: 0 | 1 },
  ) => Promise<void>;
  publishUser: (userId: string, event: SyncEvent) => void;
};

/**
 * Create a TEAM workspace owned by the caller.
 *
 * The write order is the lifecycle's: the organization (with its kind), then
 * better-auth's `member`, then the settings, and the `WorkspaceMember` mirror
 * LAST, because the mirror is what grants access. A crash before it leaves an
 * organization nobody can reach — no access, nothing listed — which is the
 * safe disagreement; the person simply creates again.
 *
 * The session is not moved: a client joins the new workspace with a full page
 * load, which addresses it explicitly from then on.
 */
export async function createTeamWorkspace(
  deps: WorkspaceCreationDeps,
  user: { id: string; name?: string | null; email?: string | null },
  input: { name: string; currency: string; weekStartsOn: 0 | 1 },
): Promise<{ workspaceId: string }> {
  const owned = (await deps.store.find("workspaceMembers", { userId: user.id })).filter(
    (row) => row.role === "owner",
  );
  if (owned.length >= MAX_OWNED_WORKSPACES) throw membershipRefused("workspace-limit-reached");

  const now = deps.now();
  const name = input.name.trim().slice(0, WORKSPACE_NAME_MAX);
  const org = await deps.store.insertOne("authOrganizations", {
    name,
    slug: teamWorkspaceSlug(name, deps.slugTail()),
    kind: "team",
    createdAt: now,
  });
  const workspaceId = asId(org.id);
  if (!workspaceId) throw new Error("membership: created organization has no id");

  await deps.store.insertOne("authMembers", {
    organizationId: workspaceId,
    userId: user.id,
    role: "owner",
    createdAt: now,
  });
  await deps.seedSettings(workspaceId, {
    currency: input.currency,
    weekStartsOn: input.weekStartsOn,
  });
  await deps.store.insertOne("workspaceMembers", {
    workspaceId,
    userId: user.id,
    role: "owner",
    name: ((user.name ?? "").trim() || (user.email ?? "")).slice(0, 200),
    hourlyRate: null,
    ...initialFlags("owner"),
    createdAt: now,
    updatedAt: now,
  });

  deps.publishUser(user.id, { kind: "membership.changed", workspaceId, reason: "joined" });
  return { workspaceId };
}
