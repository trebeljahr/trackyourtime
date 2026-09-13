"use client";

import * as React from "react";
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
import { trpc } from "@/lib/trpc";
import { errorMessage, type ProjectRow } from "./types";

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
  project: Pick<ProjectRow, "billableDefault" | "hourlyRate">,
  next: BillingChange,
): boolean {
  return (
    project.billableDefault !== next.billableDefault ||
    project.hourlyRate !== next.hourlyRate
  );
}

type Pending = {
  project: ProjectRow;
  next: BillingChange;
  impact: ProjectBillingImpact;
  resolve: (choice: ApplyChoice) => void;
};

export type ApplyToEntriesPrompt = {
  /**
   * Ask whether a billing change should reach the entries already on the
   * project. Resolves without asking when there is nothing to ask about: no
   * billing change, or no entries it could reach.
   */
  ask: (project: ProjectRow, next: BillingChange) => Promise<ApplyChoice>;
  /** Render this once, anywhere in the caller's tree. */
  dialog: React.JSX.Element;
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

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
  const utils = trpc.useUtils();
  const [pending, setPending] = React.useState<Pending | null>(null);

  const ask = React.useCallback(
    async (project: ProjectRow, next: BillingChange): Promise<ApplyChoice> => {
      if (!billingChanged(project, next)) return "new-only";

      let impact: ProjectBillingImpact;
      try {
        impact = await utils.projects.billingImpact.fetch(
          { id: project.id },
          { staleTime: 0 },
        );
      } catch (error) {
        toast.error(
          errorMessage(error, "Could not count the entries on this project."),
        );
        return null;
      }
      if (impact.entries === 0) return "new-only";

      return new Promise<ApplyChoice>((resolve) => {
        setPending({ project, next, impact, resolve });
      });
    },
    [utils],
  );

  const settle = (choice: ApplyChoice): void => {
    pending?.resolve(choice);
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
              <DialogTitle>Update existing entries?</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p data-testid="apply-to-entries-count">
                    {pending.impact.entries === 1
                      ? `1 time entry on ${pending.project.name} keeps the billing it was saved with.`
                      : `${pending.impact.entries} time entries on ${pending.project.name} keep the billing they were saved with.`}{" "}
                    New entries use the new billing either way.
                  </p>
                  <p>
                    {flagChanged
                      ? `Updating marks ${
                          pending.impact.entries === 1 ? "it" : "every one of them"
                        } ${
                          pending.next.billableDefault ? "billable" : "non-billable"
                        }, including entries you changed by hand, and reprices ${
                          pending.impact.entries === 1 ? "it" : "them"
                        }.`
                      : "Updating reprices billable time. Each entry keeps its own billable flag."}{" "}
                    Report totals change to match.
                  </p>
                  {pending.impact.invoiced > 0 ? (
                    <p data-testid="apply-to-entries-invoiced">
                      {plural(
                        pending.impact.invoiced,
                        "invoiced entry stays",
                        "invoiced entries stay",
                      )}{" "}
                      as billed.
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
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => settle("new-only")}
                data-testid="apply-to-entries-new-only"
              >
                Only new entries
              </Button>
              <Button
                onClick={() => settle("entries")}
                data-testid="apply-to-entries-accept"
              >
                Update {plural(pending.impact.entries, "entry", "entries")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  return { ask, dialog };
}
