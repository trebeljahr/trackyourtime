import type {
  WorkspaceMemberRow,
  WorkspacePermissions,
  WorkspaceRole,
  WorkspaceSummary,
} from "@starter/shared";

/**
 * Which controls the Members screen draws, per row.
 *
 * A mirror of `services/membership/permissions.ts` on the server, and nothing
 * more than a courtesy: every one of these actions is refused there when the
 * rule says no, whatever the page drew. What this module guarantees is the
 * other direction — that a control the server would refuse is never offered,
 * so nobody is handed a button whose only outcome is an error.
 *
 * It reads the viewer's `WorkspacePermissions` rather than their role, so a
 * change to what a role may do lands here through `permissionsFor` instead of
 * through a second copy of the matrix.
 */
export type RowControls = {
  roleSelect: boolean;
  timeToggle: boolean;
  moneyToggle: boolean;
  remove: boolean;
  transfer: boolean;
};

const NONE: RowControls = {
  roleSelect: false,
  timeToggle: false,
  moneyToggle: false,
  remove: false,
  transfer: false,
};

export const ownerCountOf = (rows: readonly WorkspaceMemberRow[]): number =>
  rows.filter((row) => row.role === "owner").length;

export const controlsForRow = (
  permissions: WorkspacePermissions,
  row: WorkspaceMemberRow,
  ownerCount: number,
): RowControls => {
  // Nobody edits their own role or flags, and removing yourself is `leave`.
  if (row.isSelf) return NONE;

  // `transferOwnership` is granted to owners and nobody else, which makes it
  // the one flag that says "the viewer is an owner" without reading the role.
  const viewerIsOwner = permissions.transferOwnership;
  const targetIsOwner = row.role === "owner";

  return {
    // Demoting another owner is allowed only while a second owner remains.
    roleSelect: permissions.changeRoles && (!targetIsOwner || ownerCount > 1),
    // Owner flags are forced on and cannot be edited by anyone. An admin may
    // open or close time visibility for plain members only.
    timeToggle:
      permissions.editTimeVisibility &&
      !targetIsOwner &&
      (viewerIsOwner || row.role === "member"),
    moneyToggle: permissions.editMoneyVisibility && !targetIsOwner,
    remove:
      permissions.removeMembers &&
      (row.role === "member" ||
        (viewerIsOwner && (row.role === "admin" || ownerCount > 1))),
    transfer: permissions.transferOwnership && !targetIsOwner,
  };
};

/** Why `members.leave` would be refused, or `null` when it would not. */
export type LeaveBlock = "transfer-ownership-first" | "workspace-has-no-other-members";

export const leaveBlockFor = (
  viewerRole: WorkspaceRole,
  rows: readonly WorkspaceMemberRow[],
): LeaveBlock | null => {
  const others = rows.filter((row) => !row.isSelf).length;
  if (others === 0) return "workspace-has-no-other-members";
  if (viewerRole === "owner" && ownerCountOf(rows) <= 1) return "transfer-ownership-first";
  return null;
};

/**
 * The workspace this client is working in, until the switcher exists.
 *
 * Every request that names no workspace resolves to the session default on the
 * server, so that is the one whose permissions describe what the screens are
 * showing. The first row is only a fallback for a list that marks none.
 */
export const pickActiveWorkspace = (
  list: readonly WorkspaceSummary[] | undefined,
): WorkspaceSummary | null => list?.find((row) => row.isDefault) ?? list?.[0] ?? null;

/**
 * Whether Reports offers the member filter and "group by member".
 *
 * Shown to anyone who can see colleagues' time, and to owners and admins of a
 * shared workspace even when their own time flag is closed — they manage the
 * people in it. The server intersects `memberIds` with what the caller may
 * see, so for them a colleague's id narrows to an empty report, never to the
 * colleague's time.
 */
export const canReportByMember = (workspace: WorkspaceSummary | null): boolean => {
  if (workspace === null) return false;
  if (workspace.permissions.viewOthersTime) return true;
  return workspace.memberCount > 1 && (workspace.role === "owner" || workspace.role === "admin");
};
