"use client";

import * as React from "react";
import { capturePrivateMutationAction } from "@/lib/private-mutation-guard";
import type { ProjectBillingImpact } from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { translate, useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { errorMessage, type ProjectOption } from "./types";

/**
 * What to do with the time already booked on a project whose billing changed.
 * `null` means the person backed out, and nothing is saved.
 */
export type ApplyChoice = "entries" | "new-only" | null;

/** The billing half of a project update. */
export type BillingChange = {
  billableDefault: boolean;
  hourlyRate: number | null;
};

/** True when `next` would change what new entries on `project` are billed at. */
export function billingChanged(
  project: Pick<ProjectOption, "billableDefault" | "hourlyRate">,
  next: BillingChange,
): boolean {
  return (
    project.billableDefault !== next.billableDefault ||
    project.hourlyRate !== next.hourlyRate
  );
}

type Pending = {
  project: ProjectOption;
  next: BillingChange;
  impact: ProjectBillingImpact;
  resolve: (choice: ApplyChoice) => void;
  current: () => boolean;
};

export type ApplyToEntriesPrompt = {
  /**
   * Ask whether a billing change should reach the entries already on the
   * project. Resolves without asking when there is nothing to ask about: no
   * billing change, or no entries it could reach.
   */
  ask: (project: ProjectOption, next: BillingChange) => Promise<ApplyChoice>;
  /** Render this once, anywhere in the caller's tree. */
  dialog: React.JSX.Element;
};

/**
 * Entries snapshot their billable flag and rate when they are saved, so a
 * project's billing change reaches only new time by default. This is the one
 * place that offers to rewrite the old time too, and it states what that
 * rewrite touches before anything is sent.
 *
 * One prompt for both the inline billing cell and the project dialog, so the
 * two cannot describe the same rewrite differently.
 */
export function useApplyToEntriesPrompt(): ApplyToEntriesPrompt {
  const t = useT("catalog");
  const tc = useT("common");
  const utils = trpc.useUtils();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const pendingRef = React.useRef<Pick<Pending, "resolve" | "current"> | null>(null);
  const lifetime = React.useRef({ mounted: true, revision: 0 });
  React.useEffect(() => {
    const life = lifetime.current; life.mounted = true;
    return () => { life.mounted = false; life.revision++; pendingRef.current?.resolve(null); pendingRef.current = null; };
  }, []);

  const ask = React.useCallback(
    async (project: ProjectOption, next: BillingChange): Promise<ApplyChoice> => {
      const life = lifetime.current, action = capturePrivateMutationAction(), revision = ++life.revision;
      const current = () => life.mounted && action.current() && life.revision === revision;
      if (!current()) return null;
      pendingRef.current?.resolve(null); pendingRef.current = null; setPending(null);
      if (!billingChanged(project, next)) return "new-only";

      let impact: ProjectBillingImpact;
      try {
        impact = await utils.projects.billingImpact.fetch(
          { id: project.id },
          { staleTime: 0 },
        );
      } catch (error) {
        if (!current()) return null;
        toast.error(
          errorMessage(error, translate("catalog")("errors.countEntries")),
        );
        return null;
      }
      if (!current()) return null;
      if (impact.entries === 0) return "new-only";

      return new Promise<ApplyChoice>((resolve) => {
        pendingRef.current?.resolve(null);
        const task = { resolve, current }; pendingRef.current = task;
        setPending({ project, next, impact, ...task });
      });
    },
    [utils],
  );

  const settle = (choice: ApplyChoice): void => {
    const task = pendingRef.current;
    if (!pending || task?.resolve !== pending.resolve) return;
    pendingRef.current = null;
    task.resolve(task.current() ? choice : null);
    setPending(null);
  };

  const flagChanged =
    pending !== null &&
    pending.project.billableDefault !== pending.next.billableDefault;

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="apply-to-entries-dialog">
        {pending ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("applyToEntries.title")}</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p data-testid="apply-to-entries-count">
                    {t("applyToEntries.count", {
                      count: pending.impact.entries,
                      project: pending.project.name,
                    })}
                  </p>
                  <p>
                    {flagChanged
                      ? t("applyToEntries.flagChanged", {
                          count: pending.impact.entries,
                          billable: pending.next.billableDefault
                            ? "billable"
                            : "nonBillable",
                        })
                      : t("applyToEntries.rateOnly")}
                  </p>
                  {pending.impact.invoiced > 0 ? (
                    <p data-testid="apply-to-entries-invoiced">
                      {t("applyToEntries.invoiced", {
                        count: pending.impact.invoiced,
                      })}
                    </p>
                  ) : null}
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="ghost"
                onClick={() => settle(null)}
                data-testid="apply-to-entries-cancel"
              >
                {tc("actions.cancel")}
              </Button>
              <Button
                variant="outline"
                onClick={() => settle("new-only")}
                data-testid="apply-to-entries-new-only"
              >
                {t("applyToEntries.newOnly")}
              </Button>
              <Button
                onClick={() => settle("entries")}
                data-testid="apply-to-entries-accept"
              >
                {t("applyToEntries.accept", { count: pending.impact.entries })}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  return { ask, dialog };
}
