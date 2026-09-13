"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useAuth } from "@/hooks/use-auth";
import {
  accountHasPassword,
  deleteAccount,
  type AccountDeletionRefusal,
} from "@/lib/auth-client";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";

const REFUSALS: Record<AccountDeletionRefusal, string> = {
  "password-required": "Enter your password to delete your account.",
  "invalid-password": "That password is not correct. Nothing was deleted.",
  "session-expired":
    "For an account without a password, deleting needs a recent sign-in. Sign out, sign in again, then delete within 24 hours.",
  failed: "Your account could not be deleted, and it still exists. Try again.",
};

/**
 * Settings → Account → Delete account.
 *
 * The confirmation names what goes and what stays, because in a shared
 * workspace the answer is not "everything": colleagues keep the workspace,
 * its catalog and its invoices. It points at the export before the button
 * rather than after, which is the only moment that advice is any use.
 *
 * An account with a password confirms with it — the server refuses one that
 * does not. An account without one (Google sign-in) has nothing to type, so it
 * types its email address instead, and the server requires its session to be
 * less than a day old.
 */
export function DeleteAccountCard({
  onShowExport,
}: {
  /** Switch Settings to the export panel. */
  onShowExport?: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const { user } = useAuth();
  const { pending } = useOfflineQueueState();
  const [open, setOpen] = React.useState(false);
  const [hasPassword, setHasPassword] = React.useState<boolean | null>(null);
  const [answer, setAnswer] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void accountHasPassword().then((next) => {
      if (!cancelled) setHasPassword(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const openChange = (next: boolean): void => {
    if (deleting) return;
    setOpen(next);
    if (!next) {
      setAnswer("");
      setError(null);
    }
  };

  const email = user?.email ?? "";
  const confirmed =
    hasPassword === null
      ? false
      : hasPassword
        ? answer.length > 0
        : email.length > 0 && answer.trim().toLowerCase() === email.toLowerCase();

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!user || !confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    const result = await deleteAccount({
      userId: user.id,
      password: hasPassword ? answer : undefined,
    });
    if (!result.ok) {
      setDeleting(false);
      if (result.reason === "password-required") setHasPassword(true);
      setError(REFUSALS[result.reason]);
      return;
    }
    toast.success("Your account has been deleted");
    router.replace("/login");
  };

  return (
    <Card className="border-destructive/30" data-testid="settings-danger-zone">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          Deletes your account, signs out every device, and deletes the data
          you own. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setOpen(true)}
          disabled={!user}
          data-testid="delete-account"
        >
          <Trash2 className="size-4" />
          Delete account
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent data-testid="delete-account-dialog">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Delete your account?</DialogTitle>
              <DialogDescription>
                This permanently deletes {email || "your account"} and signs
                out every device, including the browser extension, Raycast and
                the mobile app. It cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-sm" data-testid="delete-account-scope">
              <div>
                <p className="font-medium">In workspaces only you use, everything is deleted:</p>
                <p className="text-muted-foreground">
                  time entries, clients, projects, tasks, tags, pinned quick
                  starts, invoices, import history, API tokens, webhooks and
                  workspace settings.
                </p>
              </div>
              <div>
                <p className="font-medium">In workspaces you share, only your own data is deleted:</p>
                <p className="text-muted-foreground">
                  your time entries, pins, API tokens, webhooks and imports.
                  The workspace, its clients, projects, tasks, tags and invoices
                  stay, and so do entries already on an invoice. If you are its
                  last owner, ownership passes to an admin, or else to the
                  longest-standing member.
                </p>
              </div>
              <p className="text-muted-foreground">
                Want a copy first?{" "}
                {onShowExport ? (
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-4"
                    onClick={() => {
                      openChange(false);
                      onShowExport();
                    }}
                    data-testid="delete-account-export"
                  >
                    Export your data as JSON
                  </button>
                ) : (
                  "Export your data as JSON from Settings → Data"
                )}{" "}
                before you continue.
              </p>
              {pending > 0 ? (
                <p
                  className="font-medium text-destructive"
                  data-testid="delete-account-unsynced"
                >
                  {pending} change{pending === 1 ? "" : "s"} on this device{" "}
                  {pending === 1 ? "has" : "have"} not synced yet and will be
                  discarded.
                </p>
              ) : null}
            </div>

            {hasPassword === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Checking how to confirm…
              </p>
            ) : hasPassword ? (
              <div className="space-y-1.5">
                <Label htmlFor="delete-account-password">Your password</Label>
                <Input
                  id="delete-account-password"
                  type="password"
                  autoComplete="current-password"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  disabled={deleting}
                  data-testid="delete-account-password"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="delete-account-email">
                  Type <span className="font-mono">{email}</span> to confirm
                </Label>
                <Input
                  id="delete-account-email"
                  type="email"
                  autoComplete="off"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  disabled={deleting}
                  data-testid="delete-account-email"
                />
              </div>
            )}

            {error ? (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid="delete-account-error"
              >
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => openChange(false)}
                disabled={deleting}
                data-testid="delete-account-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!confirmed || deleting}
                data-testid="delete-account-confirm"
              >
                {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
                Delete account permanently
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
