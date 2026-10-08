"use client";

import * as React from "react";
import { WORKSPACE_NAME_MAX } from "@starter/shared";

import {
  assignLocation,
  enterWorkspace,
  type Navigate,
} from "@/components/members/enter-workspace";
import { NATIVE_SELECT_CLASS } from "@/components/members/members-table";
import { membershipErrorMessage } from "@/components/members/membership-errors";
import { Button } from "@/components/ui/button";
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
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { CURRENCIES, currencyName } from "@/lib/currencies";
import { trpc } from "@/lib/trpc";

export type NewWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate?: Navigate;
};

/**
 * Create a team workspace and move into it.
 *
 * Currency and week start open on the current workspace's values, the most
 * likely answer for a person's second workspace. On success the device joins
 * the new workspace through `enterWorkspace` — a full page load, like joining
 * by invitation — so nothing cached for the old workspace survives.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  navigate = assignLocation,
}: NewWorkspaceDialogProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const f = useFormat();
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000, enabled: open });
  const create = trpc.workspaces.create.useMutation();

  const [name, setName] = React.useState("");
  const [currency, setCurrency] = React.useState<string | null>(null);
  const [weekStart, setWeekStart] = React.useState<0 | 1 | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const chosenCurrency = currency ?? settings.data?.currency ?? "EUR";
  const chosenWeekStart = weekStart ?? (settings.data?.weekStartsOn === 0 ? 0 : 1);
  const currencies = CURRENCIES.includes(chosenCurrency)
    ? CURRENCIES
    : [chosenCurrency, ...CURRENCIES];

  const reset = (): void => {
    setName("");
    setCurrency(null);
    setWeekStart(null);
    setError(null);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      const { workspaceId } = await create.mutateAsync({
        name: name.trim(),
        currency: chosenCurrency,
        weekStartsOn: chosenWeekStart,
      });
      await enterWorkspace(workspaceId, navigate);
    } catch (failure) {
      setError(membershipErrorMessage(failure));
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="new-workspace-dialog">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t("newWorkspace.title")}</DialogTitle>
            <DialogDescription>{t("newWorkspace.description")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="new-workspace-name">{t("newWorkspace.name")}</Label>
            <Input
              id="new-workspace-name"
              required
              maxLength={WORKSPACE_NAME_MAX}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="new-workspace-name"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="new-workspace-currency">{t("newWorkspace.currency")}</Label>
              <select
                id="new-workspace-currency"
                className={NATIVE_SELECT_CLASS}
                value={chosenCurrency}
                onChange={(event) => setCurrency(event.target.value)}
                data-testid="new-workspace-currency"
              >
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code} · {currencyName(code, f.intlLocale)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-workspace-week-start">{t("newWorkspace.weekStart")}</Label>
              <select
                id="new-workspace-week-start"
                className={NATIVE_SELECT_CLASS}
                value={String(chosenWeekStart)}
                onChange={(event) => setWeekStart(event.target.value === "0" ? 0 : 1)}
                data-testid="new-workspace-week-start"
              >
                <option value="1">{f.weekday(1, "long")}</option>
                <option value="0">{f.weekday(0, "long")}</option>
              </select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("newWorkspace.hint")}</p>

          {error !== null ? (
            <p className="text-sm text-destructive" role="alert" data-testid="new-workspace-error">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {tc("actions.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={pending || name.trim() === ""}
              data-testid="new-workspace-submit"
            >
              {pending ? t("newWorkspace.creating") : t("newWorkspace.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
