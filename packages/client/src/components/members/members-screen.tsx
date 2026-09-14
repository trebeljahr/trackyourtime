"use client";

import * as React from "react";
import { Users } from "lucide-react";
import type {
  InvitableRole,
  PendingInvitation,
  WorkspaceMemberRow,
} from "@starter/shared";

import { ConfirmDialog } from "@/components/catalog/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { InviteForm } from "@/components/members/invite-form";
import { LeaveWorkspace } from "@/components/members/leave-workspace";
import { leaveBlockFor } from "@/components/members/member-rules";
import { membershipErrorMessage } from "@/components/members/membership-errors";
import {
  MembersTable,
  type VisibilityPatch,
} from "@/components/members/members-table";
import { PendingInvitations } from "@/components/members/pending-invitations";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import type { Navigate } from "@/components/members/enter-workspace";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

/** Which confirmation is open, and for whom. One slot, so two never stack. */
type Pending =
  | null
  | { kind: "remove"; row: WorkspaceMemberRow }
  | { kind: "transfer"; row: WorkspaceMemberRow };

export type MembersScreenProps = {
  /** Injected by tests; a full page load in the app. */
  navigate?: Navigate;
};

/**
 * Settings for the people in a workspace: who is in it, what they may see,
 * who is invited, and the way out.
 *
 * Every procedure is called WITHOUT a `workspaceId`. The server resolves the
 * workspace (the session default today; the tRPC link injects the switcher's
 * choice once that exists), and naming one here would be a second source of
 * truth for "which workspace" that the rest of the app would not share.
 *
 * Membership only ever changes through tRPC. better-auth's own
 * `/api/auth/organization/*` endpoints answer 404 on purpose, because they
 * would write the plugin's `member` row without the app's `WorkspaceMember`
 * mirror and skip the permission matrix entirely.
 */
export function MembersScreen({ navigate }: MembersScreenProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const utils = trpc.useUtils();
  const { workspace, isLoading: workspaceLoading } = useActiveWorkspace();
  const permissions = workspace?.permissions ?? null;
  const manages = permissions?.inviteMembers === true;

  const membersQuery = trpc.members.list.useQuery(undefined, {
    enabled: workspace !== null,
  });
  // Asked for only by somebody who may see it: the server refuses a plain
  // member with FORBIDDEN, and the links in it must never reach them.
  const invitationsQuery = trpc.invitations.list.useQuery(undefined, {
    enabled: manages,
  });

  const [busyMemberId, setBusyMemberId] = React.useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<Pending>(null);

  /**
   * After any change: the member rows, the viewer's own permissions (a
   * transfer turns an owner into an admin) and the invitations. The socket's
   * `membership.changed` does the same for every other device.
   */
  const refresh = React.useCallback((): void => {
    void utils.members.list.invalidate();
    void utils.workspaces.list.invalidate();
    void utils.invitations.list.invalidate();
  }, [utils]);

  const fail = React.useCallback(
    (failure: unknown): void => {
      toast.error(membershipErrorMessage(failure));
      refresh();
    },
    [refresh],
  );

  const updateRole = trpc.members.updateRole.useMutation();
  const updateVisibility = trpc.members.updateVisibility.useMutation();
  const removeMember = trpc.members.remove.useMutation();
  const transferOwnership = trpc.members.transferOwnership.useMutation();
  const leave = trpc.members.leave.useMutation();
  const createInvitation = trpc.invitations.create.useMutation();
  const cancelInvitation = trpc.invitations.cancel.useMutation();

  const run = React.useCallback(
    async (row: WorkspaceMemberRow, action: () => Promise<unknown>, success: string) => {
      setBusyMemberId(row.memberId);
      try {
        await action();
        toast.success(success);
        refresh();
      } catch (failure) {
        fail(failure);
      } finally {
        setBusyMemberId(null);
      }
    },
    [fail, refresh],
  );

  const handleRoleChange = (row: WorkspaceMemberRow, role: InvitableRole): void => {
    void run(
      row,
      () => updateRole.mutateAsync({ memberId: row.memberId, role }),
      t("toasts.roleChanged", { role, name: row.name }),
    );
  };

  const handleVisibility = (row: WorkspaceMemberRow, patch: VisibilityPatch): void => {
    void run(
      row,
      () => updateVisibility.mutateAsync({ memberId: row.memberId, ...patch }),
      t("toasts.visibilitySaved", { name: row.name }),
    );
  };

  const handleConfirmed = (): void => {
    if (confirm === null) return;
    const { row } = confirm;
    if (confirm.kind === "remove") {
      void run(
        row,
        () => removeMember.mutateAsync({ memberId: row.memberId }),
        t("toasts.removed", { name: row.name }),
      );
    } else {
      void run(
        row,
        () => transferOwnership.mutateAsync({ memberId: row.memberId }),
        t("toasts.transferred", { name: row.name }),
      );
    }
  };

  const handleCancelInvitation = async (invitation: PendingInvitation): Promise<void> => {
    setBusyInvitationId(invitation.id);
    try {
      await cancelInvitation.mutateAsync({ invitationId: invitation.id });
      toast.success(t("pending.canceled", { email: invitation.email }));
      refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusyInvitationId(null);
    }
  };

  const handleInvite = async (input: { email: string; role: InvitableRole }) => {
    const result = await createInvitation.mutateAsync(input);
    void utils.invitations.list.invalidate();
    return result;
  };

  if (workspaceLoading || (workspace !== null && membersQuery.isPending)) {
    return (
      <div className="space-y-3" data-testid="members-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (workspace === null || permissions === null || membersQuery.isError) {
    return (
      <EmptyState
        icon={Users}
        title={t("page.loadError")}
        action={
          <Button
            type="button"
            variant="outline"
            onClick={refresh}
            data-testid="members-retry"
          >
            {tc("actions.retry")}
          </Button>
        }
        testId="members-error"
      />
    );
  }

  const rows = membersQuery.data ?? [];

  return (
    <div className="space-y-6" data-testid="members-screen">
      <p className="text-sm text-muted-foreground" data-testid="members-description">
        {t("page.description", { workspace: workspace.name })}
      </p>

      <MembersTable
        rows={rows}
        permissions={permissions}
        busyMemberId={busyMemberId}
        onRoleChange={handleRoleChange}
        onVisibilityChange={handleVisibility}
        onRemove={(row) => setConfirm({ kind: "remove", row })}
        onTransfer={(row) => setConfirm({ kind: "transfer", row })}
      />

      {manages ? (
        <>
          <InviteForm canInviteAdmins={permissions.inviteAdmins} onInvite={handleInvite} />
          <PendingInvitations
            invitations={invitationsQuery.data ?? []}
            busyInvitationId={busyInvitationId}
            onCancel={(invitation) => void handleCancelInvitation(invitation)}
          />
        </>
      ) : null}

      <LeaveWorkspace
        workspaceName={workspace.name}
        block={leaveBlockFor(workspace.role, rows)}
        onLeave={() => leave.mutateAsync(undefined)}
        navigate={navigate}
      />

      <ConfirmDialog
        open={confirm?.kind === "remove"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("confirmRemove.title", { name: confirm?.row.name ?? "" })}
        description={t("confirmRemove.description", { name: confirm?.row.name ?? "" })}
        confirmLabel={t("confirmRemove.confirm")}
        cancelLabel={tc("actions.cancel")}
        onConfirm={handleConfirmed}
        testId="member-remove-dialog"
      />
      <ConfirmDialog
        open={confirm?.kind === "transfer"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("confirmTransfer.title", { name: confirm?.row.name ?? "" })}
        description={t("confirmTransfer.description", { name: confirm?.row.name ?? "" })}
        confirmLabel={t("confirmTransfer.confirm")}
        cancelLabel={tc("actions.cancel")}
        onConfirm={handleConfirmed}
        testId="member-transfer-dialog"
      />
    </div>
  );
}
