"use client";

import * as React from "react";
import type { PendingInvitation } from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyField } from "@/components/members/copy-field";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";

export type PendingInvitationsProps = {
  invitations: readonly PendingInvitation[];
  busyInvitationId: string | null;
  onCancel: (invitation: PendingInvitation) => void;
};

/**
 * Invitations nobody has answered yet, each with its link and a cancel.
 *
 * Rendered only for owners and admins — the screen does not even ask for the
 * list otherwise, and `invitations.list` refuses a plain member on the server.
 * The link is a credential-shaped thing (whoever signs in with the invited
 * address can join through it), so it is never shown to somebody who could
 * not have sent it.
 */
export function PendingInvitations({
  invitations,
  busyInvitationId,
  onCancel,
}: PendingInvitationsProps): React.JSX.Element {
  const t = useT("members");
  const format = useFormat();

  return (
    <Card data-testid="pending-invitations">
      <CardHeader>
        <CardTitle className="text-base">{t("pending.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="pending-invitations-empty">
            {t("pending.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="space-y-2 py-3 first:pt-0 last:pb-0"
                data-testid={`invitation-row-${invitation.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("pending.details", {
                        role: invitation.role,
                        inviter: invitation.inviterName,
                        date: format.date(invitation.expiresAt, "medium"),
                      })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    disabled={busyInvitationId === invitation.id}
                    aria-label={t("pending.cancelOf", { email: invitation.email })}
                    onClick={() => onCancel(invitation)}
                    data-testid={`invitation-cancel-${invitation.id}`}
                  >
                    {t("pending.cancel")}
                  </Button>
                </div>
                <CopyField
                  value={invitation.inviteUrl}
                  label={t("pending.copyLink")}
                  testId={`invitation-link-${invitation.id}`}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
