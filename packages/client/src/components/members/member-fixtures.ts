import {
  permissionsFor,
  type WorkspaceMemberRow,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@starter/shared";

/** Test rows for the Members screen. Not imported by app code. */
export const memberRow = (
  overrides: Partial<WorkspaceMemberRow> & Pick<WorkspaceMemberRow, "memberId">,
): WorkspaceMemberRow => ({
  userId: `user-${overrides.memberId}`,
  name: `Name ${overrides.memberId}`,
  email: `${overrides.memberId}@example.com`,
  role: "member",
  canViewOthersTime: false,
  canViewOthersMoney: false,
  joinedAt: "2026-08-01T10:00:00.000Z",
  isSelf: false,
  ...overrides,
});

/** One owner, one admin, one member — with `self` marking the viewer. */
export const teamRows = (self: WorkspaceRole): WorkspaceMemberRow[] => [
  memberRow({
    memberId: "owner",
    name: "Olivia Owner",
    role: "owner",
    canViewOthersTime: true,
    canViewOthersMoney: true,
    isSelf: self === "owner",
  }),
  memberRow({ memberId: "admin", name: "Adam Admin", role: "admin", isSelf: self === "admin" }),
  memberRow({ memberId: "member", name: "Mia Member", role: "member", isSelf: self === "member" }),
];

export const workspaceFor = (
  role: WorkspaceRole,
  overrides: Partial<WorkspaceSummary> = {},
  flags = { canViewOthersTime: false, canViewOthersMoney: false },
): WorkspaceSummary => ({
  id: "ws-1",
  name: "Studio",
  role,
  memberCount: 3,
  isDefault: true,
  permissions: permissionsFor(role, flags),
  ...overrides,
});
