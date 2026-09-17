// Resolving which workspace a request runs in, and what the caller may see.
//
// The rule (Stage 0, decision 3): an explicit `workspaceId` on the input ALWAYS
// wins; the session's active organization is only the default. Session-implicit
// scope is a footgun for the clients that cannot re-read it — a Raycast menu
// bar that has been open for three days, and a browser extension that follows
// the web app's sign-in without controlling it.
import type { Visibility } from "@starter/shared";
import {
  WorkspaceMember,
  visibilityOf,
  type WorkspaceMemberDocLike,
} from "../models/WorkspaceMember.js";
import {
  createPersonalWorkspace,
  type WorkspaceOwner,
} from "./personal-workspace.js";
import { getAuth } from "./auth.js";

export type ResolvedWorkspace = {
  workspaceId: string;
  membership: WorkspaceMemberDocLike;
  visibility: Visibility;
};

/**
 * The workspace a user falls back to when a request names none.
 *
 * Repair path as well as read path: any user without a membership — one that
 * predates the signup hook, or one whose hook failed — gets their personal
 * workspace created here on first use. That is what makes "every user has at
 * least one workspace" an invariant rather than an aspiration.
 */
export async function ensurePersonalWorkspace(
  user: WorkspaceOwner,
): Promise<string | null> {
  const existing = await WorkspaceMember.findOne({ userId: user.id })
    .sort({ createdAt: 1 })
    .lean();
  if (existing) return existing.workspaceId;

  return createPersonalWorkspace(getAuth().api, user);
}

/**
 * Pull a caller-supplied workspace id off the raw input.
 *
 * Raw, because this runs before the procedure's own zod schema. Nothing is
 * trusted on the strength of this value — it only selects which membership to
 * look up, and a workspace the caller is not a member of resolves to no
 * membership at all.
 */
export function workspaceIdFromInput(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The lookups `resolveWorkspace` needs, injectable so the rule is unit-tested. */
export type WorkspaceLookups = {
  membership: (
    workspaceId: string,
    userId: string,
  ) => Promise<WorkspaceMemberDocLike | null>;
  /** The oldest workspace the person is in, creating a personal one if none. */
  fallbackWorkspace: (user: WorkspaceOwner) => Promise<string | null>;
};

const mongooseLookups: WorkspaceLookups = {
  membership: async (workspaceId, userId) =>
    WorkspaceMember.findOne({ workspaceId, userId }).lean(),
  fallbackWorkspace: ensurePersonalWorkspace,
};

/**
 * Resolve the workspace for one request: explicit input, else the session's
 * active organization, else the caller's oldest membership (created on
 * demand).
 *
 * The two non-member cases are answered DIFFERENTLY, on purpose:
 *
 *  - An EXPLICIT `workspaceId` the caller is not a member of resolves to
 *    null, which the middleware answers NOT_FOUND. No fallback: a request
 *    that named a workspace must never run in a different one. The offline
 *    queue depends on exactly this — a row queued in a workspace the person
 *    has since been removed from is refused on replay, rather than quietly
 *    written into whichever workspace they happen to have left.
 *  - A STALE session default (the session still points at a workspace the
 *    person left, or was removed from, or that another device switched away
 *    from) falls back to the oldest membership. Nobody named that workspace in
 *    this request; answering NOT_FOUND would lock a cookie client out of every
 *    workspace-scoped call until the session expired.
 *
 * A workspace somebody else owns stays indistinguishable from one that does
 * not exist either way.
 */
export async function resolveWorkspace(
  args: {
    user: WorkspaceOwner;
    requested: string | null;
    activeWorkspaceId: string | null;
  },
  lookups: WorkspaceLookups = mongooseLookups,
): Promise<ResolvedWorkspace | null> {
  const resolved = (
    workspaceId: string,
    membership: WorkspaceMemberDocLike,
  ): ResolvedWorkspace => ({
    workspaceId,
    membership,
    visibility: visibilityOf(membership),
  });

  if (args.requested) {
    const membership = await lookups.membership(args.requested, args.user.id);
    return membership ? resolved(args.requested, membership) : null;
  }

  if (args.activeWorkspaceId) {
    const membership = await lookups.membership(args.activeWorkspaceId, args.user.id);
    if (membership) return resolved(args.activeWorkspaceId, membership);
  }

  const fallback = await lookups.fallbackWorkspace(args.user);
  if (!fallback) return null;
  const membership = await lookups.membership(fallback, args.user.id);
  return membership ? resolved(fallback, membership) : null;
}
