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
import { translate } from "@/i18n/translate";
import { useT } from "@/i18n/use-t";
import {
  accountHasPassword,
  deleteAccount,
  type AccountDeletionRefusal,
} from "@/lib/auth-client";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";

/** Catalog key per refusal, read when the refusal is shown. */
const REFUSALS = {
  "password-required": "deleteAccount.refusals.passwordRequired",
  "invalid-password": "deleteAccount.refusals.invalidPassword",
  "session-expired": "deleteAccount.refusals.sessionExpired",
  failed: "deleteAccount.refusals.failed",
} as const satisfies Record<AccountDeletionRefusal, string>;

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
  const t = useT("settings");
  const tc = useT("common");
  const { user } = useAuth();
  const { pending } = useOfflineQueueState();
  const [open, setOpen] = React.useState(false);
  const [hasPassword, setHasPassword] = React.useState<boolean | null>(null);
  const [answer, setAnswer] = React.useState("");
  const [error, setError] = React.useState<AccountDeletionRefusal | null>(null);
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
      setError(result.reason);
      return;
    }
    toast.success(translate("settings")("deleteAccount.toasts.deleted"));
    router.replace("/login");
  };

  return (
    <Card className="border-destructive/30" data-testid="settings-danger-zone">
      <CardHeader>
        <CardTitle className="text-destructive">{t("deleteAccount.title")}</CardTitle>
        <CardDescription>{t("deleteAccount.description")}</CardDescription>
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
          {t("deleteAccount.title")}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent data-testid="delete-account-dialog">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("deleteAccount.dialog.title")}</DialogTitle>
              <DialogDescription>
                {email
                  ? t("deleteAccount.dialog.descriptionWithEmail", { email })
                  : t("deleteAccount.dialog.description")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-sm" data-testid="delete-account-scope">
              <div>
                <p className="font-medium">{t("deleteAccount.dialog.soloTitle")}</p>
                <p className="text-muted-foreground">
                  {t("deleteAccount.dialog.soloDetail")}
                </p>
              </div>
              <div>
                <p className="font-medium">{t("deleteAccount.dialog.sharedTitle")}</p>
                <p className="text-muted-foreground">
                  {t("deleteAccount.dialog.sharedDetail")}
                </p>
              </div>
              <p className="text-muted-foreground">
                {onShowExport
                  ? t.rich("deleteAccount.dialog.exportHint", {
                      link: (chunks) => (
                        <button
                          type="button"
                          className="font-medium text-foreground underline underline-offset-4"
                          onClick={() => {
                            openChange(false);
                            onShowExport();
                          }}
                          data-testid="delete-account-export"
                        >
                          {chunks}
                        </button>
                      ),
                    })
                  : t("deleteAccount.dialog.exportHintPlain")}
              </p>
              {pending > 0 ? (
                <p
                  className="font-medium text-destructive"
                  data-testid="delete-account-unsynced"
                >
                  {t("deleteAccount.dialog.unsynced", { count: pending })}
                </p>
              ) : null}
            </div>

            {hasPassword === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("deleteAccount.dialog.checking")}
              </p>
            ) : hasPassword ? (
              <div className="space-y-1.5">
                <Label htmlFor="delete-account-password">
                  {t("deleteAccount.dialog.password")}
                </Label>
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
                  {t.rich("deleteAccount.dialog.typeEmail", {
                    email,
                    mono: (chunks) => <span className="font-mono">{chunks}</span>,
                  })}
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
                {t(REFUSALS[error])}
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
                {tc("actions.cancel")}
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!confirmed || deleting}
                data-testid="delete-account-confirm"
              >
                {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("deleteAccount.dialog.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
