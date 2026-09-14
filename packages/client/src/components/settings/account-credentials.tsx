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

/** better-auth's minimum, repeated so the form can say it before the server does. */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordChangeProblem(input: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (!input.current) return "Enter your current password.";
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    return `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (input.next !== input.confirm) return "The new passwords do not match.";
  if (input.next === input.current) return "The new password is the same as the current one.";
  return null;
}

const PASSWORD_REFUSALS: Record<string, string> = {
  INVALID_PASSWORD: "That current password is not correct. Nothing changed.",
  PASSWORD_TOO_SHORT: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
  PASSWORD_TOO_LONG: "The new password is too long.",
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
      setError(PASSWORD_REFUSALS[refusal.code ?? ""] ?? "Your password could not be changed. Try again.");
      return;
    }
    if (revokeOthers) {
      const { error: revokeRefusal } = await authClient
        .revokeOtherSessions()
        .catch(() => ({ error: { code: "FAILED" } }));
      setBusy(false);
      if (revokeRefusal) {
        toast.error("Password changed, but other devices are still signed in", {
          description: "Sign them out in Settings → Devices.",
        });
      } else {
        toast.success("Password changed. Other devices are signed out.");
      }
    } else {
      setBusy(false);
      toast.success("Password changed");
    }
    change(false);
  };

  return (
    <SettingRow
      title="Password"
      description={
        hasPassword === false
          ? "Your account signs in with Google, so it has no password to change."
          : "Change the password you sign in with."
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
        Change password
      </Button>
      <Dialog open={open} onOpenChange={change}>
        <DialogContent data-testid="change-password-dialog">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Change password</DialogTitle>
              <DialogDescription>
                Use at least {MIN_PASSWORD_LENGTH} characters.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
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
              <Label htmlFor="new-password">New password</Label>
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
              <Label htmlFor="confirm-password">Confirm new password</Label>
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
                Sign out every other device, including the mobile app, the browser
                extension and Raycast
              </Label>
            </div>
            {error ? <ErrorLine message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} data-testid="change-password-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Change password
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
      setError("Enter a valid email address.");
      return;
    }
    if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
      setError("That is already your email address.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient
      .changeEmail({ newEmail, callbackURL: webCallbackUrl("/settings") })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError("Your email could not be changed. Try again.");
      return;
    }
    setSentTo(newEmail);
  };

  return (
    <SettingRow
      title="Email address"
      description="Where sign-in links and account emails go."
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
        Change email
      </Button>
      <Dialog open={open} onOpenChange={change}>
        <DialogContent data-testid="change-email-dialog">
          {sentTo ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>Confirm the new address</DialogTitle>
                <DialogDescription data-testid="change-email-sent">
                  {mailConfigured === false
                    ? `This server sends no email, so the confirmation link for ${sentTo} was written to the server log. Your email changes when the link is opened.`
                    : `We sent a link to ${sentTo}. Your email changes when you open it.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" onClick={() => change(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              <DialogHeader>
                <DialogTitle>Change email address</DialogTitle>
                <DialogDescription>
                  Currently {currentEmail}. The new address gets a link, and the
                  change happens when you open it.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="new-email">New email address</Label>
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
                  Cancel
                </Button>
                <Button type="submit" disabled={busy} data-testid="change-email-submit">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Send link
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
