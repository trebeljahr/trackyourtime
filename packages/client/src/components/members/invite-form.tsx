"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import type { InvitableRole, InviteResult } from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyField } from "@/components/members/copy-field";
import { NATIVE_SELECT_CLASS } from "@/components/members/members-table";
import { membershipErrorMessage } from "@/components/members/membership-errors";
import { useT } from "@/i18n/use-t";

export type InviteFormProps = {
  /** Owners only: an admin may invite members and nothing more. */
  canInviteAdmins: boolean;
  onInvite: (input: { email: string; role: InvitableRole }) => Promise<InviteResult>;
};

/**
 * Invite somebody by email.
 *
 * The server decides whether the email actually went out (`emailSent`). A
 * self-hosted server with no SMTP configured still creates the invitation, and
 * the only way the invitee ever hears of it is the link — so that case shows
 * the link, with a Copy button, instead of pretending something was sent.
 */
export function InviteForm({
  canInviteAdmins,
  onInvite,
}: InviteFormProps): React.JSX.Element {
  const t = useT("members");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<InvitableRole>("member");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InviteResult | null>(null);

  // An admin never holds "admin" in state, even if the prop flips while the
  // form is open (an owner demoted mid-edit by another device).
  const effectiveRole: InvitableRole = canInviteAdmins ? role : "member";

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const next = await onInvite({ email: email.trim(), role: effectiveRole });
      setResult(next);
      setEmail("");
    } catch (failure) {
      setError(membershipErrorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card data-testid="invite-card">
      <CardHeader>
        <CardTitle className="text-base">{t("invite.title")}</CardTitle>
        <CardDescription>{t("invite.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => void submit(event)}
          data-testid="invite-form"
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="invite-email">{t("invite.email")}</Label>
            <Input
              id="invite-email"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="invite-email"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">{t("invite.role")}</Label>
            <select
              id="invite-role"
              className={NATIVE_SELECT_CLASS}
              value={effectiveRole}
              onChange={(event) =>
                setRole(event.target.value === "admin" ? "admin" : "member")
              }
              data-testid="invite-role"
            >
              <option value="member" data-testid="invite-role-member">
                {t("roles.member")}
              </option>
              {canInviteAdmins ? (
                <option value="admin" data-testid="invite-role-admin">
                  {t("roles.admin")}
                </option>
              ) : null}
            </select>
          </div>
          <Button type="submit" disabled={pending} data-testid="invite-submit">
            {pending ? t("invite.sending") : t("invite.submit")}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground" data-testid="invite-role-hint">
          {effectiveRole === "admin" ? t("invite.adminHint") : t("invite.memberHint")}
        </p>

        {error !== null ? (
          <p className="text-sm text-destructive" role="alert" data-testid="invite-error">
            {error}
          </p>
        ) : null}

        {result !== null && result.emailSent ? (
          <p
            className="flex items-center gap-2 text-sm"
            role="status"
            data-testid="invite-sent"
          >
            <CheckCircle2 className="size-4 text-primary" />
            {t("invite.sent", { email: result.invitation.email })}
          </p>
        ) : null}

        {result !== null && !result.emailSent ? (
          <div className="space-y-2" role="status" data-testid="invite-link-panel">
            <p className="text-sm" data-testid="invite-no-email">
              {t("invite.noEmail", { email: result.invitation.email })}
            </p>
            <CopyField
              value={result.invitation.inviteUrl}
              label={t("invite.link")}
              testId="invite-link"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
