"use client";
import type { ProjectBillingImpact } from "@starter/shared";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/use-t";
import type { ProjectOption } from "./types";
import type { ApplyChoice } from "./apply-to-entries-prompt";
export type BillingChange = {
  billableDefault: boolean;
  hourlyRate: number | null;
};

export type BillingConfirmationView = {
  project: ProjectOption;
  next: BillingChange;
  impact: ProjectBillingImpact;
  private: boolean;
};
/** Shared production body, also usable for isolated translated layout QA. */
export function ProjectBillingConfirmationBody({ pending, settle }: { pending: BillingConfirmationView | null; settle: (choice: ApplyChoice) => void }) {
  const t = useT("catalog"), tc = useT("common");
  const flagChanged =
    pending !== null &&
    pending.project.billableDefault !== pending.next.billableDefault;

  return (
      <DialogContent className="sm:max-w-md" data-testid="apply-to-entries-dialog">
        {pending ? (
          <>
            <DialogHeader className="min-w-0">
              <DialogTitle>{t(pending.private ? "applyToEntries.privateTitle" : "applyToEntries.title")}</DialogTitle>
              <DialogDescription asChild>
                <div className="min-w-0 space-y-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  <p data-testid="apply-to-entries-count">
                    {t(pending.private ? "applyToEntries.privateCount" : "applyToEntries.count", {
                      count: pending.impact.entries,
                      project: pending.project.name,
                    })}
                  </p>
                  <p>
                    {pending.private ? t("applyToEntries.privateNotice") : flagChanged
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
              {!pending.private && <Button
                onClick={() => settle("entries")}
                data-testid="apply-to-entries-accept"
              >
                {t("applyToEntries.accept", { count: pending.impact.entries })}
              </Button>}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
  );
}
