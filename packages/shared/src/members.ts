// Workspace membership on the wire: who is in a workspace, what each person
// may do there, and the invitations that bring somebody in.
//
// Every rule here is ENFORCED on the server (services/membership/). The
// client reads `WorkspacePermissions` to decide which buttons to draw, never
// to decide what is allowed — a hidden button is a courtesy, a refused
// mutation is the rule.
import { z } from "zod";
import type { WorkspaceRole } from "./types.js";

/**
 * The only role strings a membership may hold, in rank order.
 *
 * better-auth's plugin accepts comma-joined roles ("admin,owner") and grants
 * the union. trackyourtime never writes one and treats any string not in this
 * list as the lowest role, so a stray value can never widen access.
 * `WorkspaceRole` itself is exported from ./types.ts.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

/** True only for one of the exact strings in {@link WORKSPACE_ROLES}. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

/** Roles an invitation may carry. Ownership only ever moves by transfer. */
export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * Where a client remembers which workspace it is pointed at. Per device, not
 * per session: the extension and Raycast have no say over the web app's
 * session, which is why every request carries an explicit `workspaceId`.
 */
export const ACTIVE_WORKSPACE_STORAGE_KEY = "trackyourtime.active-workspace";

export type WorkspacePermissions = {
  inviteMembers: boolean;
  inviteAdmins: boolean;
  changeRoles: boolean;
  editTimeVisibility: boolean;
  editMoneyVisibility: boolean;
  removeMembers: boolean;
  transferOwnership: boolean;
  invoices: boolean;
  viewOthersTime: boolean;
  viewOthersMoney: boolean;
};

/**
 * What a workspace is for.
 *
 * `personal` is the one every person gets at signup: theirs alone, never
 * shared — it cannot be left, handed over, deleted or invited into.
 * `team` is every other workspace, created to be shared.
 */
export const WORKSPACE_KINDS = ["personal", "team"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * A stored kind, read defensively. Anything but the exact string "personal"
 * is a team workspace: the personal lock is the narrow exception, so a
 * missing or unknown value never makes a shared workspace private.
 */
export function asWorkspaceKind(value: unknown): WorkspaceKind {
  return value === "personal" ? "personal" : "team";
}

export type WorkspaceSummary = {
  id: string;
  name: string;
  /**
   * Absent from a server older than API level 13, which has no notion of a
   * personal workspace; a client then treats every workspace as before.
   */
  kind?: WorkspaceKind;
  role: WorkspaceRole;
  memberCount: number;
  /** The workspace a request that names none resolves to. */
  isDefault: boolean;
  permissions: WorkspacePermissions;
};

export type WorkspaceMemberRow = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
  /** Absent when the viewer cannot see this member’s money. Null inherits. */
  hourlyRate?: number | null;
  joinedAt: string;
  isSelf: boolean;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: InvitableRole;
  inviterName: string;
  expiresAt: string;
  inviteUrl: string;
};

export type InviteResult = { invitation: PendingInvitation; emailSent: boolean };

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "canceled"
  | "expired";

export type InvitationPreview = {
  id: string;
  workspaceName: string;
  inviterName: string;
  email: string;
  role: InvitableRole;
  status: InvitationStatus;
};

/**
 * A running entry in ANOTHER workspace that starting a timer stopped.
 *
 * One running timer per person, across every workspace, is the invariant
 * (teams design decision 2) — so starting in B ends A's timer. The client
 * must say so; this is what it says it with.
 */
export type StartTimerReplaced = {
  entryId: string;
  workspaceId: string;
  workspaceName: string;
  end: string;
};

/**
 * The FORBIDDEN message codes a membership action answers with, for a refusal
 * on a row that genuinely belongs to the caller's own workspace. Anything the
 * caller cannot name — another workspace's member, invitation or the
 * workspace itself — is NOT_FOUND instead, so it cannot be probed.
 */
export const MEMBERSHIP_REFUSALS = [
  "owner-required",
  "admin-required",
  "cannot-modify-self",
  "cannot-modify-owner",
  "transfer-ownership-first",
  "workspace-has-no-other-members",
  "already-member",
  "invitation-email-mismatch",
  "invitation-not-pending",
  "invite-limit-reached",
  "invoice-permission-required",
  "personal-workspace-cannot-leave",
  "personal-workspace-cannot-transfer",
  "personal-workspace-cannot-invite",
  "workspace-limit-reached",
] as const;
export type MembershipRefusal = (typeof MEMBERSHIP_REFUSALS)[number];

/** True when a server error message is one of the stable refusal codes. */
export function isMembershipRefusal(value: unknown): value is MembershipRefusal {
  return (
    typeof value === "string" &&
    (MEMBERSHIP_REFUSALS as readonly string[]).includes(value)
  );
}

/**
 * What a role with these flags may do, as the server decides it.
 *
 * Owners always see everything: the flags are forced on for them, so they
 * are read from the role rather than trusted from the row.
 */
export function permissionsFor(
  role: WorkspaceRole,
  flags: { canViewOthersTime: boolean; canViewOthersMoney: boolean },
): WorkspacePermissions {
  const owner = role === "owner";
  const manager = owner || role === "admin";
  const viewOthersTime = owner || flags.canViewOthersTime;
  const viewOthersMoney = owner || flags.canViewOthersMoney;
  return {
    inviteMembers: manager,
    inviteAdmins: owner,
    changeRoles: owner,
    editTimeVisibility: manager,
    editMoneyVisibility: owner,
    removeMembers: manager,
    transferOwnership: owner,
    // Invoices total everybody's billable time, so they need both flags as
    // well as a managing role.
    invoices: manager && viewOthersTime && viewOthersMoney,
    viewOthersTime,
    viewOthersMoney,
  };
}

const workspaceId = z.string().min(1).max(64).optional();
const recordId = z.string().min(1).max(64);

/**
 * `z.string().email()` alone accepts surrounding whitespace in some inputs
 * and never case-folds, so the address is trimmed before validation and
 * lower-cased after it: one person must not be invitable twice as
 * "Bob@x.com" and "bob@x.com".
 */
const invitedEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().email().max(320).transform((value) => value.toLowerCase()),
);

export const inviteMemberSchema = z.object({
  workspaceId,
  email: invitedEmail,
  role: z.enum(INVITABLE_ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const memberIdSchema = z.object({ workspaceId, memberId: recordId });
export type MemberIdInput = z.infer<typeof memberIdSchema>;

export const updateMemberRateSchema = memberIdSchema.extend({
  hourlyRate: z.number().finite().min(0).max(1_000_000).nullable(),
});

export const updateRoleSchema = z.object({
  workspaceId,
  memberId: recordId,
  role: z.enum(INVITABLE_ROLES),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const updateVisibilitySchema = z.object({
  workspaceId,
  memberId: recordId,
  canViewOthersTime: z.boolean().optional(),
  canViewOthersMoney: z.boolean().optional(),
});
export type UpdateVisibilityInput = z.infer<typeof updateVisibilitySchema>;

export const invitationIdSchema = z.object({ id: recordId });
export type InvitationIdInput = z.infer<typeof invitationIdSchema>;

export const cancelInvitationSchema = z.object({
  workspaceId,
  invitationId: recordId,
});
export type CancelInvitationInput = z.infer<typeof cancelInvitationSchema>;

export const workspaceScopeSchema = z
  .object({ workspaceId })
  .optional();

export const setActiveWorkspaceSchema = z.object({ workspaceId: recordId });
export type SetActiveWorkspaceInput = z.infer<typeof setActiveWorkspaceSchema>;

/** Longest workspace name accepted, the same cap a member name gets. */
export const WORKSPACE_NAME_MAX = 80;

/**
 * `workspaces.create`: a new TEAM workspace, owned by the caller. A personal
 * workspace is never created this way — everybody already has theirs.
 */
export const createWorkspaceSchema = z.object({
  name: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().min(1).max(WORKSPACE_NAME_MAX),
  ),
  // The same rule as `currencyCodeSchema` in ./schemas.ts, written out so
  // this file keeps importing nothing but zod (Raycast vendors it for types).
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter ISO 4217 code")
    .transform((value) => value.toUpperCase()),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
