"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { ErrorLine } from "@/components/settings/two-factor";
import { SettingRow } from "@/components/settings/setting-row";
import { authClient, webCallbackUrl } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";

/** better-auth's minimum, repeated so the form can say it before the server does. */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordChangeProblem(input: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  const t = translate("settings");
  if (!input.current) return t("password.problems.currentMissing");
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    return t("password.problems.tooShort", { min: MIN_PASSWORD_LENGTH });
  }
  if (input.next !== input.confirm) return t("password.problems.mismatch");
  if (input.next === input.current) return t("password.problems.unchanged");
  return null;
}

/** The server's refusal of a password change, in the reader's language. */
const passwordRefusal = (code: string | undefined): string => {
  const t = translate("settings");
  switch (code) {
    case "INVALID_PASSWORD":
      return t("password.problems.wrongCurrent");
    case "PASSWORD_TOO_SHORT":
      return t("password.problems.tooShort", { min: MIN_PASSWORD_LENGTH });
    case "PASSWORD_TOO_LONG":
      return t("password.problems.tooLong");
    default:
      return t("password.problems.failed");
  }
};

/**
 * Settings → Account → Password.
 *
 * "Sign out other devices" is on by default: the usual reason to change a
 * password is that someone else might know it. The server deletes every
 * other session, and `ws/session-watch.ts` closes their sockets with 4401.
 *
 * That is two requests, not `changePassword`'s own `revokeOtherSessions`.
 * better-auth's flag deletes THIS session as well and issues a new one, while
 * the server's after-hook sweeps sockets before the response (and its new
 * cookie) reaches the browser — so this device's own socket was closed as
 * revoked and the app signed itself out. `/revoke-other-sessions` keeps the
 * current session, so nothing here changes credential at all.
 */
export function ChangePasswordRow({ hasPassword }: { hasPassword: boolean | null }): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [revokeOthers, setRevokeOthers] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const change = (value: boolean): void => {
    if (busy) return;
    setOpen(value);
    if (!value) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setRevokeOthers(true);
      setError(null);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient
      .changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: false,
      })
      .catch(() => ({ error: { code: "FAILED" } }));
    if (refusal) {
      setBusy(false);
      setError(passwordRefusal(refusal.code));
      return;
    }
    if (revokeOthers) {
      const { error: revokeRefusal } = await authClient
        .revokeOtherSessions()
        .catch(() => ({ error: { code: "FAILED" } }));
      setBusy(false);
      if (revokeRefusal) {
        toast.error(t("password.toasts.othersStillSignedIn"), {
          description: t("password.toasts.othersStillSignedInHint"),
        });
      } else {
        toast.success(t("password.toasts.changedOthersSignedOut"));
      }
    } else {
      setBusy(false);
      toast.success(t("password.toasts.changed"));
    }
    change(false);
  };

  return (
    <SettingRow
      title={t("password.title")}
      description={
        hasPassword === false ? t("password.googleAccount") : t("password.description")
      }
      testId="setting-password"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={hasPassword !== true}
        onClick={() => setOpen(true)}
        data-testid="change-password"
      >
        {t("password.change")}
      </Button>
      <Dialog open={open} onOpenChange={change}>
        <DialogContent data-testid="change-password-dialog">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("password.change")}</DialogTitle>
              <DialogDescription>
                {t("password.minLength", { min: MIN_PASSWORD_LENGTH })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="current-password">{t("password.current")}</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                data-testid="change-password-current"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{t("password.new")}</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                data-testid="change-password-new"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">{t("password.confirm")}</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                data-testid="change-password-confirm"
              />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="revoke-other-sessions"
                checked={revokeOthers}
                onCheckedChange={(value) => setRevokeOthers(value === true)}
                data-testid="change-password-revoke"
              />
              <Label htmlFor="revoke-other-sessions" className="font-normal leading-snug">
                {t("password.revokeOthers")}
              </Label>
            </div>
            {error ? <ErrorLine message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                {tc("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy} data-testid="change-password-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("password.change")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Settings → Account → Email.
 *
 * The server mails a verification link to the NEW address and changes the
 * email only when it is opened, so a typo cannot move the account to an
 * address nobody reads. On a server with no mail transport the link is
 * written to the server log instead, and the confirmation says that.
 */
export function ChangeEmailRow({
  currentEmail,
  mailConfigured,
}: {
  currentEmail: string;
  /** `health.check`'s `authConfig.emailVerificationRequired`; undefined while loading. */
  mailConfigured: boolean | undefined;
}): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const change = (value: boolean): void => {
    if (busy) return;
    setOpen(value);
    if (!value) {
      setEmail("");
      setSentTo(null);
      setError(null);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const newEmail = email.trim();
    if (!EMAIL_PATTERN.test(newEmail)) {
      setError(t("email.invalid"));
      return;
    }
    if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
      setError(t("email.same"));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient
      .changeEmail({ newEmail, callbackURL: webCallbackUrl("/settings") })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError(t("email.failed"));
      return;
    }
    setSentTo(newEmail);
  };

  return (
    <SettingRow
      title={t("email.title")}
      description={t("email.description")}
      testId="setting-email"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!currentEmail}
        onClick={() => setOpen(true)}
        data-testid="change-email"
      >
        {t("email.change")}
      </Button>
      <Dialog open={open} onOpenChange={change}>
        <DialogContent data-testid="change-email-dialog">
          {sentTo ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t("email.sentTitle")}</DialogTitle>
                <DialogDescription data-testid="change-email-sent">
                  {mailConfigured === false
                    ? t("email.sentToLog", { email: sentTo })
                    : t("email.sent", { email: sentTo })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" onClick={() => change(false)}>
                  {tc("actions.done")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t("email.dialogTitle")}</DialogTitle>
                <DialogDescription>{t("email.current", { email: currentEmail })}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="new-email">{t("email.newAddress")}</Label>
                <Input
                  id="new-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  data-testid="change-email-input"
                />
              </div>
              {error ? <ErrorLine message={error} /> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => change(false)}>
                  {tc("actions.cancel")}
                </Button>
                <Button type="submit" disabled={busy} data-testid="change-email-submit">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("email.sendLink")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
