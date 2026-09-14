"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/catalog/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import type { LeaveBlock } from "@/components/members/member-rules";
import { membershipErrorMessage } from "@/components/members/membership-errors";
import {
  enterWorkspace,
  assignLocation,
  type Navigate,
} from "@/components/members/enter-workspace";
import { useT } from "@/i18n/use-t";

export type LeaveWorkspaceProps = {
  workspaceName: string;
  /** Why the server would refuse, so the button can say so instead of failing. */
  block: LeaveBlock | null;
  onLeave: () => Promise<{ nextWorkspaceId: string }>;
  navigate?: Navigate;
};

/**
 * Leave the workspace, for every role.
 *
 * Disabled with the reason when the server's rule would refuse: the last
 * owner of a workspace other people still use has to hand it over first
 * (a shared workspace always keeps an owner), and the only member has nobody
 * to leave it to.
 */
export function LeaveWorkspace({
  workspaceName,
  block,
  onLeave,
  navigate = assignLocation,
}: LeaveWorkspaceProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const [confirming, setConfirming] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  const leave = async (): Promise<void> => {
    setPending(true);
    try {
      const { nextWorkspaceId } = await onLeave();
      await enterWorkspace(nextWorkspaceId, navigate);
    } catch (failure) {
      toast.error(membershipErrorMessage(failure));
      setPending(false);
    }
  };

  const reason =
    block === "transfer-ownership-first"
      ? t("leave.blockedLastOwner")
      : block === "workspace-has-no-other-members"
        ? t("leave.blockedOnlyMember")
        : null;

  return (
    <Card data-testid="leave-workspace">
      <CardHeader>
        <CardTitle className="text-base">{t("leave.title")}</CardTitle>
        <CardDescription>{t("leave.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button
          type="button"
          variant="outline"
          className="text-destructive"
          disabled={reason !== null || pending}
          onClick={() => setConfirming(true)}
          data-testid="leave-workspace-button"
        >
          {t("leave.button")}
        </Button>
        {reason !== null ? (
          <p className="text-sm text-muted-foreground" data-testid="leave-workspace-blocked">
            {reason}
          </p>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("leave.confirmTitle", { workspace: workspaceName })}
        description={t("leave.confirmDescription")}
        confirmLabel={t("leave.confirm")}
        cancelLabel={tc("actions.cancel")}
        onConfirm={() => void leave()}
        testId="leave-workspace-dialog"
      />
    </Card>
  );
}
